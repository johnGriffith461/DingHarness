import { app, BrowserWindow, ipcMain, shell } from "electron";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { registerAiIpc } from "./ipc/ai";
import { registerSessionIpc } from "./ipc/sessionStore";
import { registerCanvasIpc } from "./ipc/canvas";
import { registerCanvasExportIpc } from "./ipc/canvasExport";
import { registerAssetScheme, registerImageIpc, serveAssets } from "./ipc/imageGen";
import { registerArtifactIpc } from "./ipc/artifactStore";
import { registerDriveIpc } from "./ipc/driveStore";
import { registerScheduleIpc } from "./ipc/scheduleStore";
import { registerDocIpc } from "./ipc/docStore";
import { registerReaderIpc } from "./ipc/readerStore";
import { registerAgentIpc } from "./ipc/agentStore";
import { registerSearchHistoryIpc } from "./ipc/searchStore";
import { loadWorkspaces, registerWorkspaceIpc } from "./ipc/workspaceStore";
import { registerMcpIpc, startAllMcp, stopAllMcp } from "./ipc/mcpStore";
import { registerLibraryIpc } from "./ipc/libraryStore";
import { registerTaskIpc } from "./ipc/taskStore";
import { registerMemoryIpc } from "./ipc/memoryStore";
import { registerVideoIpc } from "./ipc/videoGen";
import { registerRemoteIpc } from "./ipc/remote";
import { registerClipboardIpc } from "./ipc/clipboard";
import { registerCodingIpc } from "./ipc/codingStore";
import { APP_SETTINGS_CHANNEL, loadAppSettings, saveAppSettings } from "./ipc/appSettings";

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
 */
async function shouldUseDevServer(): Promise<boolean> {
  if (app.isPackaged) return false;
  if (!fs.existsSync(rendererIndex())) return true;
  if (process.env.VITE_DEV_SERVER_URL) return true;
  try {
    const res = await fetch(DEV_SERVER, { method: "HEAD" });
    return res.ok || res.status === 404;
  } catch {
    return false;
  }
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
 * 取 package.json 的 `productName`）。产品从 Dingwork 更名为 Ding Harness 之后
 * 这个名字就变了 —— 不搬的话，老用户升级上来会看到"数据全没了"。
 */
const LEGACY_PRODUCT_DIR = "Dingwork";

/**
 * 把旧身份的数据目录整体搬到新身份名下（**一次性**）。
 *
 * ⚠️ 必须在**第一次写 userData 之前**跑。`bootLog` 会往 `userData/boot.log` 写，
 * 那一写就把新目录建出来了 —— 于是"新目录不存在"这个前置条件永远不成立，
 * 迁移静默退化成空操作。这正是迁移类代码最容易骗过自己的形状。
 *
 * 三条边界：
 *   · 只对**打包态**做（开发态的数据目录是工程根的 `data/`，与身份无关）；
 *   · 新目录**已经存在**就什么都不做（不合并、不覆盖 —— 用户可能已经在新版里用过了）；
 *   · 旧目录不存在就什么都不做（新装用户，压根没有"旧数据"）。
 */
function migrateLegacyUserData(): void {
  if (!app.isPackaged) return;
  try {
    const next = app.getPath("userData");
    const prev = path.join(path.dirname(next), LEGACY_PRODUCT_DIR);
    if (next === prev || !fs.existsSync(prev) || fs.existsSync(next)) return;
    fs.cpSync(prev, next, { recursive: true });
    bootLog(`已从旧数据目录迁移：${prev} → ${next}`);
  } catch (error) {
    // 迁不过去也**不动**旧目录：老数据原样留在原处，用户至少还找得到
    bootLog(`旧数据目录迁移失败（继续用新目录）：${error instanceof Error ? error.message : String(error)}`);
  }
}

migrateLegacyUserData();

bootLog(`main 入口 isPackaged=${app.isPackaged} __dirname=${__dirname}`);

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

process.on("uncaughtException", (error) => {
  bootLog(`未捕获异常：${error.stack ?? error.message}`);
});
process.on("unhandledRejection", (reason) => {
  bootLog(`未处理的 Promise 拒绝：${reason instanceof Error ? reason.stack : String(reason)}`);
});

/**
 * 数据目录。
 *
 * 分两种情况，因为**打包后 `__dirname` 在 asar 里，是只读的**：
 *   · 打包后：用系统 userData（`%APPDATA%\工作台`）—— 安装目录不可写，写那里会直接失败
 *   · 开发期：用工程根的 `data/`（`.gitignore` 已排除）—— 能直接翻快照文件排查问题
 * 两种情况都可以用 `DSH_CANVAS_DATA_DIR` 覆盖（多份数据并行测试时用）。
 */
function configureDataDir(): void {
  const override = process.env.DSH_CANVAS_DATA_DIR;
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

async function createWindow(): Promise<void> {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 640,
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
    // 无边框 + 自绘标题栏（对标原版的沉浸式外壳）
    titleBarStyle: "hidden",
    titleBarOverlay: { color: "#0f1115", symbolColor: "#c9d1d9", height: 36 },
    webPreferences: {
      // preload 编译为 CJS，扩展名是 .cjs（见 scripts/mark-electron-cjs.mjs），必须给绝对路径
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  win.once("ready-to-show", () => win?.show());
  win.on("closed", () => {
    win = null;
  });

  // 外部链接交给系统浏览器，不在应用内打开
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: "deny" };
  });

  if (await shouldUseDevServer()) {
    await win.loadURL(DEV_SERVER);
    win.webContents.openDevTools({ mode: "detach" });
  } else {
    await win.loadFile(rendererIndex());
  }
}

/* ---------- IPC ---------- */

/*
 * 标题栏覆盖层跟随主题。
 *
 * `titleBarOverlay` 是**创建窗口时**的选项，之后要改只能调 `setTitleBarOverlay`。
 * 不接这条通路的话，覆盖层会一直停在创建时那个颜色，
 * 于是浅色主题下窗口按钮仍是一块深色 —— 与整体不一致。
 */
ipcMain.handle("app:titlebar", (event, payload: { color: string; symbolColor: string }) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  // height 沿用创建时的值，这里只改颜色
  win?.setTitleBarOverlay({ color: payload.color, symbolColor: payload.symbolColor, height: 36 });
  return true;
});

ipcMain.handle("app:ping", () => ({
  ok: true,
  platform: process.platform,
  versions: {
    electron: process.versions.electron,
    node: process.versions.node,
    chrome: process.versions.chrome,
  },
}));

ipcMain.handle("app:userDataDir", () => app.getPath("userData"));

try {
  registerAiIpc();
  registerSessionIpc(ipcMain);
} catch (error) {
  // AI 通道起不来不该拖垮整个应用：日志里说清楚，窗口照常开
  console.error("[ai] 注册失败：", error instanceof Error ? error.message : error);
}

try {
  registerCanvasIpc();
registerCanvasExportIpc();
} catch (error) {
  console.error("[canvas] 注册失败：", error instanceof Error ? error.message : error);
}

// 图像生成：IPC + 自定义资源协议（协议必须在 app ready 之前登记）
try {
  registerAssetScheme();
  registerImageIpc();
  registerArtifactIpc(ipcMain);
  registerDriveIpc(ipcMain, () => win);
  registerMemoryIpc();
  registerScheduleIpc(ipcMain);
  registerDocIpc();
  registerReaderIpc();
  registerAgentIpc();
  registerSearchHistoryIpc();
  registerWorkspaceIpc(() => win);
  registerMcpIpc();
  registerLibraryIpc(ipcMain);
  registerTaskIpc(ipcMain);
  registerVideoIpc(ipcMain);
  registerRemoteIpc(ipcMain);
registerClipboardIpc(ipcMain);
registerCodingIpc(ipcMain);
/* 本机版设置（§183）：新对话默认模型 */
ipcMain.handle(APP_SETTINGS_CHANNEL.read, () => loadAppSettings());
ipcMain.handle(APP_SETTINGS_CHANNEL.write, (_e, next: unknown) => saveAppSettings(next));
} catch (error) {
  console.error("[image] 注册失败：", error instanceof Error ? error.message : error);
}

app.whenReady().then(() => {
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
  void loadWorkspaces().finally(() => {
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

/* 退出前把连接器的子进程收掉，别在系统里留孤儿进程 */
app.on("before-quit", () => {
  stopAllMcp();
});
