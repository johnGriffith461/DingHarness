import { app, BrowserWindow, ipcMain, screen, session, shell } from "electron";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { APP_CHANNEL } from "./ipc/appChannel";
import { isAllowedExternalUrl, isAllowedNavigation, withFrameAncestors } from "./ipc/navigationGuard";
import { probeViteDevServer } from "./ipc/devServerProbe";
import { ensureSingleInstance } from "./ipc/singleInstance";
import { safeRegister } from "./ipc/registerGuard";
import { clampToWorkArea } from "./ipc/windowBounds";
import { registerAiIpc } from "./ipc/ai";
import { loadPluginsAtStartup, registerPluginIpc } from "./ipc/pluginHost";
import { registerSpaceIpc } from "./ipc/spaceHost";
import { registerSessionIpc, desktopSessionStore } from "./ipc/sessionStore";
import { registerStatsIpc } from "./ipc/stats";
import { registerWorkflowIpc } from "./ipc/workflowStore";
import { registerReviewIpc } from "./ipc/review";
import { registerSkillsIpc } from "./ipc/skills";
import { registerKnowledgeIpc } from "./ipc/knowledge";
import { registerModelConfigIpc } from "./ipc/modelConfig";
import { loadCustomProvidersIntoMemory, registerProviderIpc } from "./ipc/providerConfig";
import { registerPreviewIpc } from "./ipc/preview";
import { registerComputerIpc } from "./ipc/computer";
import { registerCanvasIpc } from "./ipc/canvas";
import { registerCanvasExportIpc } from "./ipc/canvasExport";
import { registerAssetScheme, registerImageIpc, serveAssets } from "./ipc/imageGen";
import { registerArtifactIpc } from "./ipc/artifactStore";
import { registerDiagnosticsIpc } from "./ipc/diagnostics";
import { registerProjectIpc } from "./ipc/project";
import { registerAttachmentIpc } from "./ipc/attachments";
import { registerToolsIpc } from "./ipc/tools";
import { recordCrash } from "./ipc/crashLog";
import { registerDriveIpc } from "./ipc/driveStore";
import { registerScheduleIpc } from "./ipc/scheduleStore";
import { registerDocIpc } from "./ipc/docStore";
import { registerReaderIpc } from "./ipc/readerStore";
import { registerAgentIpc } from "./ipc/agentStore";
import { registerSearchHistoryIpc } from "./ipc/searchStore";
import { loadWorkspaces, registerWorkspaceIpc } from "./ipc/workspaceStore";
import { registerMcpIpc, startAllMcp, stopAllMcp } from "./ipc/mcpStore";
import { registerLspIpc, stopAllLsp } from "./ipc/lsp";
import { closeBrowserHost } from "./ipc/browserHost";
import { registerLibraryIpc } from "./ipc/libraryStore";
import { registerTaskIpc } from "./ipc/taskStore";
import { registerMemoryIpc } from "./ipc/memoryStore";
import { registerVideoIpc } from "./ipc/videoGen";
import { registerRemoteIpc } from "./ipc/remote";
import { attachWindowEvents, registerWindowIpc } from "./ipc/windowControls";
import { registerDesktopSecretCipher, registerSecretsIpc } from "./ipc/secretStore";
import { registerClipboardIpc } from "./ipc/clipboard";
import { registerCodingIpc } from "./ipc/codingStore";
import { APP_SETTINGS_CHANNEL, loadAppSettings, saveAppSettings } from "./ipc/appSettings";
import { closeKv } from "../engine/adapters/kvStore";

/**
 * 渲染产物 `dist/index.html` 的绝对路径。
 *
 * 主进程产物在 `dist-electron/electron/main.js`（放开 rootDir 后多了一层 `electron/`），
 * 所以要从 `__dirname` 往上走**两层**才到工程根。曾经只走一层，导致路径指向
 * `dist-electron/dist/index.html`（不存在）→ 判定"没有产物"→ 回去连 dev server → 白窗口。
 */
function rendererIndex(): string {
  return path.join(__dirname, "..", "..", "dist", "index.html");
}

/** 开发期由 `vite.config.ts` 的 server.port 固定为 5173。 */
const DEV_SERVER = process.env.VITE_DEV_SERVER_URL ?? "http://localhost:5173";

/**
 * 是否加载 Vite dev server。
 *
 * 判定不能只看 `app.isPackaged`：从源码直接 `electron .` 时它同样是 false，
 * 但那时只构建了 dist/、并没有在跑 dev server，照旧去连 5173 会在 devtools 里
 * 报 `ERR_CONNECTION_REFUSED` 并留一个白窗口。所以再探一次本机端口。
 *
 * ⚠️ **审计 P12**：原来探的是 `HEAD` 且判 `res.ok || res.status === 404` —— 404 也算通过。
 * 于是 5173 上任何一个别的服务（哪怕只会回 404）都会让应用去 `loadURL` 并注入整套 preload，
 * 得到白窗口。现在真取一次页面、且必须看到 Vite 客户端标记才算（见 `./ipc/devServerProbe`）。
 */
async function shouldUseDevServer(): Promise<boolean> {
  if (app.isPackaged) return false;
  if (!fs.existsSync(rendererIndex())) return true;
  if (process.env.VITE_DEV_SERVER_URL) return true;
  return probeViteDevServer(DEV_SERVER);
}

/**
 * 启动日志。
 *
 * 打包后的 Windows 应用**静默退出/静默卡住**时最难查：没有控制台、stderr 也拿不到。
 * 所以主进程一进来就把关键节点写进一个稳定位置的日志文件。
 *
 * 位置分两处，一起写：
 *   · `userData/boot.log` —— 正常排查用（跟着数据走）
 *   · 系统临时目录 —— 兜底：万一 userData 还没就绪，这里也能留下痕迹
 * 这个文件同时能证明"主进程到底有没有跑起来"。
 */
/**
 * **启动阶段打点**（T2，2026-10-19）。
 *
 * 为什么要有：目标是「可操作 < 1.5s」，而实测中位数 ~2.4s。
 * 只说「慢了」没用 —— 需要知道慢在进程启动、主进程准备、还是首屏渲染。
 * 每条都从**进程启动**算（`process.uptime()`，不依赖墙钟）。
 */
function bootMark(stage: string): void {
  bootLog(`[boot +${Math.round(process.uptime() * 1000)}ms] ${stage}`);
}
function bootLog(message: string): void {
  const line = `[${new Date().toISOString()} pid=${process.pid}] ${message}\n`;
  const targets = [
    path.join(app.getPath("userData"), "boot.log"),
    path.join(os.tmpdir(), "ding-harness-boot.log"),
  ];
  for (const file of targets) {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.appendFileSync(file, line, "utf8");
    } catch {
      /* 日志写不进去也不能影响启动 */
    }
  }
}

/**
 * 无应用、最早期的日志：只依赖 `process`，不碰 electron 的任何 API。
 * 如果连这条都没落下来，就说明主进程脚本本身没有被加载。
 */
function rawLog(message: string): void {
  try {
    fs.appendFileSync(
      path.join(os.tmpdir(), "ding-harness-boot.log"),
      `[${new Date().toISOString()} pid=${process.pid}] RAW ${message}\n`,
      "utf8",
    );
  } catch {
    /* 同上 */
  }
}

rawLog(`脚本已加载 argv=${JSON.stringify(process.argv.slice(1))} cwd=${process.cwd()}`);

/**
 * 旧身份的数据目录名（Phase 0.2）。
 *
 * 打包态的 userData 是 `%APPDATA%\<productName>`（Electron 的 `app.getName()`
 * 取 package.json 的 `productName`）。产品更名过**两次**，所以有**两代**老名字：
 *
 * | 代 | 目录名 |
 * |---|---|
 * | 第一代 | `工作台`（那时 productName 就是中文） |
 * | 第二代 | `Dingwork` |
 * | 现在 | `Ding Harness`（见 package.json 的 `productName`） |
 *
 * ⚠️ 只认一个名字（原来只认 `Dingwork`）= 第一代用户升级上来看到"数据全没了"（D6）。
 * 顺序是**从新到旧**：跨过两代升级的用户，第二代目录里的数据最新。
 */
const LEGACY_PRODUCT_DIRS = ["Dingwork", "工作台"];

/**
 * 一个目录里有没有"我们的数据"。
 *
 * 判据只认我们自己落的东西（会话库 / KV 库 / 画布目录 / 顶层 JSON）——
 * Electron 自己会往 userData 里写一堆缓存目录，不能拿"目录非空"当"用过"。
 */
function hasOurData(dir: string): boolean {
  if (fs.existsSync(path.join(dir, "canvas"))) return true;
  try {
    return fs.readdirSync(dir).some((f) => f === "sessions.db" || f === "stores.db" || f.endsWith(".json"));
  } catch {
    return false;
  }
}

/**
 * 把旧身份的数据目录整体搬到新身份名下（**一次性**）。
 *
 * ⚠️ **判据不能是"新目录不存在"**（这是 D6 点名的真 bug）：Electron 在启动早期就把
 * userData 建出来了（Chromium 的缓存目录也会进去），那个前置条件**永远不成立** ——
 * 迁移于是静默退化成空操作。改成看"新目录里有没有我们的数据"。
 *
 * 三条边界：
 *   · 只对**打包态**做（开发态的数据目录是工程根的 `data/`，与身份无关）；
 *   · 新目录**已经有我们的数据**就什么都不做（不合并、不覆盖 —— 用户可能已经在新版里用过了）；
 *   · 旧目录不存在 / 里面没有我们的数据就什么都不做（新装用户，压根没有"旧数据"）。
 */
function migrateLegacyUserData(): void {
  if (!app.isPackaged) return;
  try {
    const next = app.getPath("userData");
    if (hasOurData(next)) return;
    for (const name of LEGACY_PRODUCT_DIRS) {
      const prev = path.join(path.dirname(next), name);
      if (next === prev || !fs.existsSync(prev) || !hasOurData(prev)) continue;
      fs.mkdirSync(next, { recursive: true });
      // force:false + errorOnExist:false → 只补新目录里缺的，**绝不覆盖**已有文件
      fs.cpSync(prev, next, { recursive: true, force: false, errorOnExist: false });
      bootLog(`已从旧数据目录迁移（${name}）：${prev} → ${next}`);
      return;
    }
  } catch (error) {
    // 迁不过去也**不动**旧目录：老数据原样留在原处，用户至少还找得到
    bootLog(`旧数据目录迁移失败（继续用新目录）：${error instanceof Error ? error.message : String(error)}`);
  }
}

migrateLegacyUserData();

bootMark("main 入口");

/**
 * 打包产物的调试端口开关。
 *
 * 打包后的 Electron **不认**命令行上的 `--remote-debugging-port`（那是 dev 运行时的行为），
 * 所以自动化验收连不上 CDP。这里给一个显式开关：只有真的设了
 * `DSH_DEBUG_PORT` 才开，正常使用时它不存在 —— 不会给用户留一个默认敞开的调试口。
 */
const debugPort = process.env.DSH_DEBUG_PORT;
if (debugPort) {
  app.commandLine.appendSwitch("remote-debugging-port", debugPort);
  bootLog(`已开启调试端口 ${debugPort}`);
}

/*
 * 崩溃：**同时**写 boot.log 与 crashes.jsonl（G17）。
 *
 * boot.log 是"启动过程"的流水，不进诊断包；crashes.jsonl 才是"崩溃证据"——
 * 它会进诊断包（最近 5 条、已脱敏）。两处都写，是因为它们回答不同的问题：
 * "它是在哪一步崩的" vs "崩在哪行代码"。
 */
function recordEverywhere(kind: "uncaught-exception" | "unhandled-rejection", error: unknown): void {
  const dirs = [app.getPath("userData"), path.join(__dirname, "..", "..", "data")];
  for (const dir of dirs) {
    /* 写不进去时静默跳过 —— 崩溃处理器里再抛会变成递归崩溃 */
    recordCrash(dir, kind, error, {
      ...(app.isReady() ? { version: app.getVersion() } : {}),
      platform: `${process.platform} ${process.arch}`,
    });
  }
}
process.on("uncaughtException", (error) => {
  bootLog(`未捕获异常：${error.stack ?? error.message}`);
  recordEverywhere("uncaught-exception", error);
});
process.on("unhandledRejection", (reason) => {
  bootLog(`未处理的 Promise 拒绝：${reason instanceof Error ? reason.stack : String(reason)}`);
  recordEverywhere("unhandled-rejection", reason);
});

/**
 * 数据目录。
 *
 * 分两种情况，因为**打包后 `__dirname` 在 asar 里，是只读的**：
 *   · 打包后：用系统 userData（`%APPDATA%\Ding Harness`）—— 安装目录不可写，写那里会直接失败
 *   · 开发期：用工程根的 `data/`（`.gitignore` 已排除）—— 能直接翻快照文件排查问题
 * 两种情况都可以用 `DING_DATA_DIR` 覆盖（多份数据并行测试时用）；
 * 旧名 `DH_DATA_DIR` / `DSH_CANVAS_DATA_DIR` 继续认（2026-10-19 改名，验收脚本大量在用）。
 */
function configureDataDir(): void {
  const override =
    process.env.DING_DATA_DIR?.trim() ||
    process.env.DH_DATA_DIR?.trim() ||
    process.env.DSH_CANVAS_DATA_DIR?.trim();
  if (!override && app.isPackaged) return; // 直接用系统默认 userData
  const dir = override ? path.resolve(override) : path.join(__dirname, "..", "..", "data");
  try {
    fs.mkdirSync(dir, { recursive: true });
    app.setPath("userData", dir);
    bootLog(`数据目录已切到 ${dir}`);
  } catch (error) {
    bootLog(`数据目录设置失败：${error instanceof Error ? error.message : String(error)}`);
  }
}

configureDataDir();

let win: BrowserWindow | null = null;

/*
 * 单实例锁（**审计 P39**）。
 *
 * 必须在数据目录切好（`configureDataDir()`）之后抢锁：Electron 的单实例锁落在
 * **userData 目录**上，所以两份不同 `DSH_CANVAS_DATA_DIR` 的数据各起一个实例是允许的
 * （验收脚本就是这么并行跑的），而同一份数据起第二个实例会被挡住 —— 正是我们要的：
 * 两个进程并发写同一份 `stores.db` / `sessions.db` / 一批 JSON 才会出 split-brain。
 *
 * 没抢到锁就**尽快退出**，别去建窗口、别去注册 IPC（否则两个实例都活着，
 * 用户看到两个界面、两边互相覆盖数据）。第二个实例被拉起时，把已有窗口亮出来。
 */
const isPrimaryInstance = ensureSingleInstance(app, () => {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.focus();
});
if (!isPrimaryInstance) {
  bootLog("检测到已有实例在运行，本进程退出（P39 单实例锁）");
  app.quit();
}

async function createWindow(): Promise<void> {
  /*
   * 窗口尺寸按屏幕可用区钳制（**审计 P63**）：小屏 / 高 DPI 上写死 1440×900、
   * 最小 1024×640 会让窗口比屏幕大、底部输入区掉到屏外，还不许用户缩小。
   */
  const bounds = clampToWorkArea(screen.getPrimaryDisplay().workArea, {
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 640,
  });
  win = new BrowserWindow({
    width: bounds.width,
    height: bounds.height,
    minWidth: bounds.minWidth,
    minHeight: bounds.minHeight,
    show: false,
    backgroundColor: "#0f1115",
    /**
     * 窗口图标。
     *
     * 打包后 exe 自带的图标由 electron-builder 写进 PE 资源，这里再给一次是为了
     * **开发态**（直接 `electron .`）和任务栏也能显示我们的图标，而不是 Electron 默认那个。
     * 路径按打包与否取不同位置：打包后在 asar 外层的 build/（files 里没包含 build，
     * 所以退回 resourcesPath），开发态就在仓库根。
     */
    icon: (() => {
      const candidates = [
        path.join(__dirname, "..", "..", "build", "icon.ico"),
        path.join(process.resourcesPath ?? "", "icon.ico"),
      ];
      for (const file of candidates) {
        try {
          if (file && fs.existsSync(file)) return file;
        } catch {
          /* 找不到就不设，走 Electron 默认图标，不影响启动 */
        }
      }
      return undefined;
    })(),
    /*
     * 无边框 + 自绘标题栏（对标原版的沉浸式外壳）。
     *
     * ⚠️ **不要加回 `titleBarOverlay`**（2026-10-15 删，M0 工单 1）：
     * 它让 Windows 在窗体顶部覆盖层里再画一套**原生** caption 按钮，位置固定在
     * 右上角约 138×36 —— 而本应用的「云盘 / 插件·技能·伙伴 / 定时任务」三个视图
     * 自己的操作按钮（`wb-cloud-new` 等）就在 x=1359..1426（视口 1440），
     * 正好被那套原生按钮压住。OS 层实拍证据：`.verify/m0/repro-cloud-topright.png`。
     * 用户报的「右上角按钮重复显示」就是这个 —— 同一个角挤了两簇。
     *
     * 现在窗口按钮由应用自己画（`src/workbench/TitleBar.tsx` → `electron/ipc/windowControls.ts`），
     * 拖动区也在那里（全仓唯一一处 `-webkit-app-region: drag`）。
     * 回归守卫：`src/windowChrome.test.ts`，别绕过它。
     */
    titleBarStyle: "hidden",
    /*
     * 菜单栏：Windows 上不设的话按一次 Alt 就会闪出系统菜单栏，而本应用的命令都在界面里。
     * 不设它时默认是 `true`（长期显示），比"闪现"更糟。
     */
    autoHideMenuBar: true,
    webPreferences: {
      // preload 编译为 CJS，扩展名是 .cjs（见 scripts/mark-electron-cjs.mjs），必须给绝对路径
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      /*
       * ⚠️ `sandbox: false` 是**有意的取舍**（审计 P06 要求写明理由）。
       *
       * 沙箱化 preload 只提供**极有限的** `require`（electron / events / timers / url），
       * 而我们这份 preload 是 tsc 直编的 CJS、里面有一串**相对路径 require**
       * （`require("./ipc/windowControls")` 这些通道常量表，见 electron/preload.ts）。
       * 打开 sandbox 会直接让 preload 加载失败 → `window.shell` 一个方法都没有 →
       * 整个渲染层失联。要真上沙箱，得先把 preload 用 bundler 打成单文件
       * （把那串相对 require 内联掉），那是另一件事。
       *
       * 当前这道边界靠 `contextIsolation: true` + `nodeIntegration: false`：
       * 渲染进程拿不到 Node，能力只能经 preload 暴露的具名窄接口。
       * 回归守卫：`src/electronGuards.test.ts`（钉住这条取舍与 preload 的相对依赖）。
       */
      sandbox: false,
    },
  });

  win.once("ready-to-show", () => win?.show());
  win.on("closed", () => {
    win = null;
  });
  // 最大化状态变了要推给自绘标题栏（双击 / Win+↑ / Snap 都要跟上）
  attachWindowEvents(win);

  /*
   * 新窗口一律不开在应用内；只有**白名单协议**才交给系统浏览器（**审计 P06**）。
   *
   * 原来是 `void shell.openExternal(url)` 不看协议 —— 页面里一个 `file:///…`
   * 或 `javascript:` 链接都会被原样递给系统去打开。
   */
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isAllowedExternalUrl(url)) void shell.openExternal(url);
    else console.warn(`[shell] 已拒绝打开非白名单协议的链接：${url}`);
    return { action: "deny" };
  });

  /*
   * **审计 P06**：页面自己 `location.href = …` 不经过 `setWindowOpenHandler` ——
   * 不接 `will-navigate` 的话，应用窗口能被导航去任意站点（连 preload 都在那条页面上继续挂着）。
   * 只放行应用自身文档与开发态 dev server 的同源页面；外链转交系统浏览器。
   */
  win.webContents.on("will-navigate", (event, url) => {
    const allowed = isAllowedNavigation(url, {
      fileUrl: pathToFileURL(rendererIndex()).toString(),
      devServerUrl: DEV_SERVER,
    });
    if (allowed) return;
    event.preventDefault();
    if (isAllowedExternalUrl(url)) void shell.openExternal(url);
    else console.warn(`[shell] 已拦下应用内导航（非白名单）：${url}`);
  });

  /*
   * 渲染进程消失（G17）：白屏最常见的原因，而之前**只有白屏、没有任何记录**。
   * 记下 reason/exitCode —— 它区分"用户强杀"与"真的崩了"。
   */
  win.webContents.on("render-process-gone", (_event, details) => {
    const detail = `reason=${details.reason} exitCode=${details.exitCode}`;
    bootLog(`渲染进程消失：${detail}`);
    for (const dir of [app.getPath("userData"), path.join(__dirname, "..", "..", "data")]) {
      recordCrash(dir, "renderer-gone", details.reason, {
        ...(app.isReady() ? { version: app.getVersion() } : {}),
        platform: `${process.platform} ${process.arch}`,
        detail,
      });
    }
  });

  if (await shouldUseDevServer()) {
    await win.loadURL(DEV_SERVER);
    win.webContents.openDevTools({ mode: "detach" });
  } else {
    await win.loadFile(rendererIndex());
    bootMark("renderer 已加载");
  }
}

/* ---------- IPC ---------- */

/*
 * 注册留话：打包态没有控制台，唯一拿得到的现场是 `boot.log`。
 * 失败同时进 console 与 boot.log（**审计 P45**：原来只有一行 console.error）。
 */
function logRegisterFailure(message: string): void {
  console.error(message);
  bootLog(message);
}

ipcMain.handle(APP_CHANNEL.ping, () => ({
  ok: true,
  platform: process.platform,
  versions: {
    electron: process.versions.electron,
    node: process.versions.node,
    chrome: process.versions.chrome,
  },
}));

ipcMain.handle(APP_CHANNEL.userDataDir, () => app.getPath("userData"));

/*
 * **审计 P45**：一个模块一层 try。
 *
 * 原来是三个大 try 把二十来个注册包在一起 —— 大块内**任一**个抛错，
 * 它后面那一串注册全部被跳过（打包态表现成"某个页面整个失联"）。
 * 现在坏的那个只丢它自己，其余照常注册；失败同时进 boot.log。
 */
safeRegister("ai", () => registerAiIpc(), logRegisterFailure);
safeRegister("plugin", () => registerPluginIpc(ipcMain, () => win), logRegisterFailure);
/* 团队空间（V5-3 的产品面）：名册/配对码/共享/接管/账本 —— 操作的是数据目录里的 space.json */
safeRegister("space", () => registerSpaceIpc(), logRegisterFailure);
/* 插件装载**不 await**：它是"用户后来装的东西"，慢了或坏了都不该挡应用起来 */
safeRegister("plugin-load", () => void loadPluginsAtStartup(), logRegisterFailure);
safeRegister("session", () => registerSessionIpc(ipcMain), logRegisterFailure);
/* 请求追踪 + 用量（V6-2c/2d）：只读同一份 sessions.db，不另记遥测 */
safeRegister("stats", () => registerStatsIpc(), logRegisterFailure);
/* 工作流（V6-2l）：只读列定义/运行 + 存定义；运行在 CLI（不在这里再装配一套引擎） */
safeRegister("workflow", () => registerWorkflowIpc(), logRegisterFailure);
/* 逐文件改动审阅（U08）：从会话库还原改动、按文件回滚（路径走 ownedDirs 白名单） */
safeRegister("review", () => registerReviewIpc(ipcMain), logRegisterFailure);
/* 技能（G08）：主进程读 <userData>/skills，渲染层只要拼好的那段提示 */
safeRegister("skills", () => registerSkillsIpc(ipcMain), logRegisterFailure);
/* 本地知识库（G15）：桌面面板 + knowledge_search 工具 */
safeRegister("knowledge", () => registerKnowledgeIpc(ipcMain, () => win), logRegisterFailure);
  safeRegister("providers", () => registerProviderIpc(() => app.getPath("userData")), logRegisterFailure);
  /* 启动时把磁盘里的自定义供应商装进内核（与 CLI 同一条） */
  safeRegister(
    "providers:load",
    () => {
      const { rejected } = loadCustomProvidersIntoMemory(app.getPath("userData"));
      for (const item of rejected) bootLog("[provider] " + item.id + " 未生效：" + item.why);
    },
    logRegisterFailure,
  );
  safeRegister(
    "modelConfig",
    () => registerModelConfigIpc(() => app.getPath("userData")),
    logRegisterFailure,
  );
/* 内置浏览器预览（V6-2m）：只允许本机地址、独立持久分区 */
safeRegister("preview", () => registerPreviewIpc(), logRegisterFailure);
/* Computer Use（V6-2n）：默认关；每个动作原生确认 + 留痕（不记输入内容） */
safeRegister("computer", () => registerComputerIpc(() => win), logRegisterFailure);

safeRegister("canvas", () => registerCanvasIpc(), logRegisterFailure);
safeRegister("canvas-export", () => registerCanvasExportIpc(), logRegisterFailure);

/* 图像生成：IPC + 自定义资源协议（协议必须在 app ready 之前登记） */
safeRegister("asset-scheme", () => registerAssetScheme(), logRegisterFailure);
safeRegister("image", () => registerImageIpc(), logRegisterFailure);
safeRegister("artifact", () => registerArtifactIpc(ipcMain), logRegisterFailure);
/* 诊断包导出（2026-10-17）：技能面板「反馈」的真归宿（本地形态，不上报） */
safeRegister("diagnostics", () => registerDiagnosticsIpc(ipcMain), logRegisterFailure);
/* 项目规则与环境（A1/A2）：主进程读 AGENTS.md / package.json，渲染层只收结果 */
safeRegister("project", () => registerProjectIpc(ipcMain), logRegisterFailure);
safeRegister("attachments", () => registerAttachmentIpc(ipcMain), logRegisterFailure);
safeRegister("tools", () => registerToolsIpc(ipcMain), logRegisterFailure);
safeRegister("drive", () => registerDriveIpc(ipcMain, () => win), logRegisterFailure);
safeRegister("memory", () => registerMemoryIpc(), logRegisterFailure);
safeRegister("schedule", () => registerScheduleIpc(ipcMain), logRegisterFailure);
safeRegister("doc", () => registerDocIpc(), logRegisterFailure);
safeRegister("reader", () => registerReaderIpc(), logRegisterFailure);
safeRegister("agent", () => registerAgentIpc(), logRegisterFailure);
safeRegister("search-history", () => registerSearchHistoryIpc(), logRegisterFailure);
safeRegister("workspace", () => registerWorkspaceIpc(() => win), logRegisterFailure);
safeRegister("mcp", () => registerMcpIpc(), logRegisterFailure);
safeRegister("lsp", () => registerLspIpc(ipcMain), logRegisterFailure);
safeRegister("library", () => registerLibraryIpc(ipcMain), logRegisterFailure);
safeRegister("task", () => registerTaskIpc(ipcMain), logRegisterFailure);
safeRegister("video", () => registerVideoIpc(ipcMain), logRegisterFailure);
safeRegister("remote", () => registerRemoteIpc(ipcMain), logRegisterFailure);
safeRegister("clipboard", () => registerClipboardIpc(ipcMain), logRegisterFailure);
safeRegister("coding", () => registerCodingIpc(ipcMain), logRegisterFailure);
/* 窗口控制（自绘标题栏的按钮：最小化 / 最大化·还原 / 关闭） */
safeRegister("window", () => registerWindowIpc(ipcMain, () => win), logRegisterFailure);
/* 本机版设置（§183）：新对话默认模型 */
safeRegister(
  "app-settings",
  () => {
    ipcMain.handle(APP_SETTINGS_CHANNEL.read, () => loadAppSettings());
    ipcMain.handle(APP_SETTINGS_CHANNEL.write, (_e, next: unknown) => saveAppSettings(next));
  },
  logRegisterFailure,
);

app.whenReady().then(() => {
  bootMark("app ready");
  /* 没抢到单实例锁的进程已经在退出路上，别再建窗口 / 注册（P39） */
  if (!isPrimaryInstance) return;
  /*
   * 先把设置读一次（U03）：权限规则要进主进程缓存，而 `agentTools()` 是同步装配 ——
   * 不预热的话，用户点过「总是允许」的规则在第一轮里读不到（表现是又问一次）。
   */
  void loadAppSettings().catch((error: unknown) => {
    console.error("[settings] 启动时读设置失败（用默认值继续）：", error);
  });
  /*
   * 注册系统密钥保护（Phase 14.2）——safeStorage 要 app ready 之后才可用。
   * 注册之后 `engine/adapters/secretStore` 才知道"这台机器上能不能加密地存 key"。
   */
  registerDesktopSecretCipher();
  /* 设置里填 key 的那两个通道（见 electron/ipc/secretStore.ts） */
  registerSecretsIpc(ipcMain);
  /*
   * **审计 P06**：`frame-ancestors` 在 `<meta>` 形式的 CSP 里**不生效**，
   * 只能由响应头补 —— 应用文档那条 CSP 就是 meta 形式，所以"禁止被别人 iframe 嵌套"
   * 这一条落在这里。已有 CSP 响应头时追加、不替换（`withFrameAncestors`）。
   */
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({ responseHeaders: withFrameAncestors(details.responseHeaders) });
  });
  // 资源协议要在 ready 之后接上处理器
  try {
    serveAssets();
  } catch (error) {
    console.error("[asset] 协议接载失败：", error instanceof Error ? error.message : error);
  }
  /*
   * 授权目录要先读进来（`ownedDirs()` 是同步的，靠内存缓存）。
   * 放在建窗口之前：不然第一批工具调用可能跑在"还没加载"的空白名单上 ——
   * 那会让 write_file 报"不在可写范围内"，而用户明明授权过。
   */
  bootMark("开始读工作区授权");
  void loadWorkspaces().finally(() => {
    bootMark("工作区授权读完");
    void createWindow();
  });
  /*
   * 连接器（MCP）**不阻塞建窗口**：某个 server 起不来（命令写错、依赖没装）
   * 不该让用户看不到界面。连上之后工具自然出现在下一轮请求里。
   */
  void startAllMcp().catch((e) => console.error("[mcp] 启动连接器时出错：", e));
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) void createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

/*
 * **子进程消失**（G17）：连接器（MCP）是子进程，它自己死掉时之前只有一句
 * console 输出。记下来 —— "连接器突然没工具了"要能对上"它什么时候死的"。
 */
app.on("child-process-gone", (_event, details) => {
  const detail = `type=${details.type} reason=${details.reason} exitCode=${details.exitCode}`;
  bootLog(`子进程消失：${detail}`);
  for (const dir of [app.getPath("userData"), path.join(__dirname, "..", "..", "data")]) {
    recordCrash(dir, "child-process-gone", details.reason, {
      ...(app.isReady() ? { version: app.getVersion() } : {}),
      platform: `${process.platform} ${process.arch}`,
      detail,
    });
  }
});

/* 退出前把连接器的子进程收掉，别在系统里留孤儿进程 */
app.on("before-quit", () => {
  stopAllMcp();
  /* G6：语言服务器也是子进程，退出时一并收掉 */
  stopAllLsp();
  /* G04：agent 浏览器窗口也不留（它是我们开的，用户没手动关就还在） */
  try {
    closeBrowserHost();
  } catch {
    /* 已经关了就算了 */
  }
  /*
   * ⚠️ P142：也要**关掉数据库句柄**。原来这里只 `stopAllMcp()`：
   *   · `stores.db`（KV）的句柄在进程活着的整段时间里常开（缓存按目录存），
   *     用户这时跑 `ding backup` / `ding resume` 就是同文件第二个连接 → `SQLITE_BUSY`
   *     → 写回落文件（split-brain 的触发器）；
   *   · Windows 上句柄没放掉，数据目录/库文件就删不掉（`closeKv` 的注释记过这条）。
   * `closeKv()` 不给参数 = 关掉所有目录；失败了也不该拦住退出。
   */
  try {
    closeKv();
  } catch (error) {
    console.error("[kv] 关句柄失败：", error instanceof Error ? error.message : error);
  }
  try {
    desktopSessionStore().close();
  } catch (error) {
    console.error("[session] 关句柄失败：", error instanceof Error ? error.message : error);
  }
});
