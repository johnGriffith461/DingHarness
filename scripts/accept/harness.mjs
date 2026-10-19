import { spawnSync, spawn } from "node:child_process";
import net from "node:net";
import fs from "node:fs";

/**
 * 验收脚本的共用收口。（§135 起）
 *
 * 为什么要有这个文件：§101/§109/§135 三次撞到同一个类别 —— **验收脚本的环境问题**，
 * 而不是产品问题：
 *   · 上一条脚本没退干净 → 下一条的数据目录删不掉（EPERM）、或被单实例锁挡住；
 *   · 异常路径上没杀子进程 → 留下孤儿实例，占住目录与调试端口；
 *   · 截图偶发超时（窗口被遮挡 / 合成器不给帧）→ 把整条验收拖红。
 *
 * 这三件都不是"被测的东西坏了"，却都会让验收红。所以收进这里，一次修对。
 *
 * ⚠️ 只杀 electron.exe / Ding Harness.exe —— **不要**按 `DoubaoWork` 或 `工作台` 杀：
 * 那是**用户本体的进程**（我这边是复刻版，进程名不同）。
 */

/**
 * 「印了 ✗ 就要真的红」——共用的收口（2026-10-16，审计 G15 / P 段同族）。
 *
 * ## 它挡的是什么（实测数出来的）
 *
 * 全仓有 **20 条**验收脚本会把不对的地方印出来（`✗ …` / `❌ …`），
 * 却**从不改退出码** —— 在批跑里它们**永远是绿的**，等于没测。
 * 一条条去改判定当然也行，但"新脚本又写回旧样子"这条路必须一起堵上，
 * 所以给一个共用的：脚本开头调一次 `failOnMarks()`，
 * 之后**任何一条含 ✗ / ❌ 的输出**都会让进程以 1 退出。
 *
 * ⚠️ 两条边界如实记：
 *   · 它只把"脚本已经印出来的失败"变成退出码，**不发明新判据**；
 *   · 重试过程中的临时 ✗（"这次没通，再试一次"）会被误判成失败 ——
 *     那种脚本**不要调它**（或在重试成功时把 ✗ 换成别的记号）。
 */
export function failOnMarks() {
  for (const name of ["log", "error", "warn"]) {
    const orig = console[name];
    console[name] = (...args) => {
      const text = args.map((a) => (typeof a === "string" ? a : "")).join(" ");
      if (/✗|❌/.test(text)) process.exitCode = 1;
      orig(...args);
    };
  }
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * 本次验收跑的**标记**（2026-10-16，审计 G43 的修法）。
 *
 * ⚠️ 原来清残留是 `taskkill /F /IM electron.exe /T` —— **按程序名全机强杀**：
 * 同机上别人的 Electron 应用（另一个会话正在跑的验证实例、用户自己装的应用）
 * 会被一起杀掉。审计者的验证会话就是这么被打断的，而且它还会留下孤儿。
 *
 * 现在：验收起的每个应用都带上这个独一无二的开关（`--dsh-accept-run=<tag>`），
 * 清残留**只按自己的标记认领** —— 别人的进程一个都不碰。
 * 标记不带路径，所以换了仓库目录、跑的是 release 产物，一样认得出。
 *
 * ⚠️⚠️ **2026-10-16 补正（这条原来是坏的）**：上面写着"只按自己的标记认领"，
 * 而实现判的是 `cmd.includes("--dsh-accept-run=")` —— **只要有这个开关就认领**，
 * 标签写了却没用上。后果当场撞到：本机有**两个会话同时在跑验收**，
 * 于是甲清残留时把乙的应用杀掉了，表现成"脚本跑着跑着
 * `Target page, context or browser has been closed`"（看着像产品崩了，
 * 其实是隔壁会话收走了我们的窗口）。这与 G43 要修的是同一件事，只是方向相反：
 * 按"开关存在"认领 = 谁带开关都算我的 = 一样会误杀别人的。
 *
 * 现在判的是**完整标签**（`<开关><本次的标记>`）。更早那些跑崩留下的孤儿
 * **不再被自动杀** —— 宁可留个孤儿（`leftoverCount()` 会数出来），
 * 也不误杀隔壁会话正在验的东西（G43 定下的取舍，这里只是把它真正实现）。
 */
export const ACCEPT_RUN_TAG = `dh-accept-${process.pid}-${Date.now().toString(36)}`;
const RUN_SWITCH = "--dsh-accept-run=";

/** 本线程起过的应用标记（认领只认这些；见上面那段补正）。 */
const ownTags = new Set([ACCEPT_RUN_TAG]);

/**
 * 列出**带我们开关**的 Electron 进程（PID + 完整命令行）。
 *
 * @returns {Array<{pid:number, cmd:string}> | null} null = 查不出来（没有 powershell）
 */
function ownAppProcesses() {
  const psCmd =
    "Get-CimInstance Win32_Process -Filter \"Name='electron.exe' or Name='Ding Harness.exe'\" | ForEach-Object { [string]$_.ProcessId + '|' + $_.CommandLine }";
  const got = spawnSync("powershell", ["-NoProfile", "-Command", psCmd], { encoding: "utf8" });
  if (got.error || typeof got.stdout !== "string") return null;
  const out = [];
  for (const line of got.stdout.split(/\r?\n/)) {
    const at = line.indexOf("|");
    if (at <= 0) continue;
    const pid = Number(line.slice(0, at).trim());
    const cmd = line.slice(at + 1);
    if (!Number.isInteger(pid) || pid <= 0) continue;
    /* 认领判据：带**我们自己的**完整标记（不是"带开关就算我的"，见文件头那段补正） */
    if ([...ownTags].some((tag) => cmd.includes(RUN_SWITCH + tag))) out.push({ pid, cmd });
  }
  return out;
}

/** 现在还活着的**我们自己的**应用进程数（查不出来时返回 -1，调用方据此降级）。 */
export function leftoverCount() {
  const own = ownAppProcesses();
  if (own) return own.length;
  /*
   * 没有 powershell（或它被策略挡住）：退回"按程序名数"——
   * ⚠️ 这个数**只用于等待**（等到 0 或者超时），不用于杀进程 ——
   * 所以数到别人的进程最多让等待变长，不会误杀。
   */
  const r = spawnSync("tasklist", ["/FI", "IMAGENAME eq electron.exe", "/NH"], { encoding: "utf8" });
  const s = r.stdout ?? "";
  if (/no tasks|没有运行|信息: 没有/i.test(s)) return 0;
  return (s.match(/electron\.exe/gi) ?? []).length;
}

/**
 * 清掉我们自己起的 Electron 残留（含渲染器/GPU 子进程），**并等到真的清干净**。
 *
 * ⭐ 为什么不能只 `taskkill` 一下就返回（§137）：`taskkill /F` 发出后进程不会瞬间消失，
 * 强杀期间**新的实例起不来** —— 表现是脚本报 `ECONNREFUSED` 或
 * `ws disconnected code=1006`（端口开了又断），看不清是产品坏了还是环境。
 *
 * 判据和 `waitForPort` 一样：**等那个真条件（进程数为 0），不等固定秒数。**
 * 连续两次读到 0 才算稳，避免刚好卡在退出过程中间。
 *
 * ⚠️ 只杀 electron.exe / Ding Harness.exe —— **不要**按 `DoubaoWork` 或 `工作台` 杀：
 * 那是**用户本体的进程**（我这边是复刻版，进程名不同）。
 */
export async function killLeftovers({ budgetMs = 12000 } = {}) {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    /*
     * ⚠️ 只按**我们自己的开关**认领（G43）。查不出进程表时**不杀** ——
     * "宁可留一个孤儿，也不误杀别人"是这里刻意的取舍：孤儿下一轮还能按开关认领，
     * 误杀别人的进程是不可挽回的（审计者的验证实例就是这么挂的）。
     */
    const own = ownAppProcesses();
    if (own) {
      for (const { pid } of own) spawnSync("taskkill", ["/F", "/T", "/PID", String(pid)], { stdio: "ignore" });
    }
    await sleep(450);
    const left = leftoverCount();
    if (left === 0) {
      await sleep(450);
      if (leftoverCount() === 0) return true;
    }
  }
  return leftoverCount() === 0;
}

/**
 * 备好一个干净的数据目录。
 *
 * Windows 上 `rmSync` 会在文件仍被句柄占着时报 EPERM —— 而"占着的人"往往是
 * 上一条脚本的孤儿实例。所以**先杀干净再删，删不掉就重试**，并把失败如实返回。
 */
export async function freshDir(dir) {
  await killLeftovers();
  for (let i = 0; i < 6; i += 1) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      return true;
    } catch {
      await sleep(700);
    }
  }
  return !fs.existsSync(dir);
}

/**
 * 尽力截图：**失败不拖红验收**。
 *
 * 截图是"留给人看的证据"，不是判定依据（判定看的是 DOM/计算样式/磁盘）。
 * 一次偶发超时不该让一条功能全过的验收变红 —— 那会训练出"红了大概没事"的习惯。
 * 返回是否成功，由调用方决定写进 report。
 */
export async function shot(page, path) {
  try {
    await page.screenshot({ path, timeout: 8000 });
    return true;
  } catch {
    return false;
  }
}

/** 连子进程一起杀（child.kill() 在 Windows 上只杀主进程，Chromium 子进程会留守）。 */
export async function killTree(child) {
  if (!child || !child.pid) return;
  spawnSync("taskkill", ["/F", "/T", "/PID", String(child.pid)], { stdio: "ignore" });
  await sleep(600);
}

/** 端口通不通（TCP 能连上就算通）。 */
function canConnect(port, timeoutMs = 600) {
  return new Promise((resolve) => {
    const sock = net.createConnection({ host: "127.0.0.1", port });
    const done = (v) => {
      sock.destroy();
      resolve(v);
    };
    sock.setTimeout(timeoutMs);
    sock.on("connect", () => done(true));
    sock.on("timeout", () => done(false));
    sock.on("error", () => done(false));
  });
}

/**
 * 等调试端口真的开起来 —— **不要用固定 sleep 代替它**。
 *
 * ⭐ 为什么需要（§137 查明）：验收脚本里有"**自己 kill 掉实例、再自己 boot 一个**"的写法。
 * 第二个实例起来时，第一个还没释放**单实例锁**，于是第二个**直接自杀** → 调试端口从没打开
 * → 脚本报 `ECONNREFUSED`。机器有负载时这个竞态更容易输，所以**红的那条每次都换**
 * —— 这正是 §119~§122 三个都没查明原因的"批跑偶发红"。
 *
 * 固定 `setTimeout(8000)` 赌的是"8 秒够久"，而这里赌的是"端口开了没有" —— 后者才是真条件。
 */
export async function waitForPort(port, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await canConnect(port)) return true;
    await sleep(400);
  }
  return false;
}

/**
 * 等**页面**出现，并把"没有页面"这种情形说清楚（§160 加的）。
 *
 * ⚠️ 为什么需要它：调试端口开了 **不等于** 窗口建出来了。
 * 实测撞到过一次死法：漏跑 `node scripts/mark-electron-cjs.mjs`（`tsc` 产出的是 `.js`，
 * 而入口链要 `.cjs`）——
 * 应用**不报错、端口照开**，就是**一个页面都不建**。
 * 这时 `ctx.waitForEvent("page")` 只会干等到超时，报出来的是
 * "Timeout 30000ms exceeded"，**完全指不到真原因**。
 *
 * 所以这里：轮询拿页面；拿不到就回一句"检查 .cjs 标记那一步"，别让人再猜。
 *
 * @param browser 已连上的 CDP 浏览器
 * @param timeoutMs 最多等多久
 * @returns 页面；拿不到返回 null（**由调用方决定怎么报**）
 */
export async function waitForPage(browser, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const ctx of browser.contexts()) {
      const pages = ctx.pages();
      if (pages.length) return pages[0];
    }
    await sleep(400);
  }
  return null;
}

/**
 * C-01：首页把项目 / 附件 / 插件 / 计划 / 思考 / 用量 / 收进了「更多」。
 *
 * 操作这些 chip 的验收脚本先调它（有「更多」就展开；任务页没有这个按钮，直接跳过）。
 * 这不是绕过 UI：用户也是这么点开高级选项的。
 */
export async function expandComposerMore(page) {
  const more = page.locator('[data-testid="wb-composer-more"]');
  if ((await more.count()) === 0) return false;
  await more.click().catch(() => undefined);
  await sleep(250);
  return true;
}

/** 拿不到页面时的诊断话术（把最可能的原因直接写在报错里）。 */
export const NO_PAGE_HINT =
  "应用起了但**一个页面都没建**。先查这一条：跑过 `npx tsc -p tsconfig.electron.json` 之后" +
  "必须紧跟 `node scripts/mark-electron-cjs.mjs`（tsc 产 .js，入口链要 .cjs）——" +
  "漏了它应用不报错、端口照开，就是没有窗口。";

/**
 * 起一个应用实例并**确认它的调试端口真的开了**。
 *
 * 同时设 `DSH_DEBUG_PORT` 与 CLI 参数：项目里两种写法都有，而只有 CLI 时
 * `main.ts` 那句 `appendSwitch("remote-debugging-port", undefined)` 会多带一个空开关，
 * 两份写法并存也是历史遗留 —— 这里统一成都给。
 *
 * @returns {Promise<{child: import("node:child_process").ChildProcess, port: number, ok: boolean}>}
 *   `ok=false` 表示端口始终没开（多半是被单实例锁挡住），调用方应据此**报出真因**，
 *   而不是继续往下点按钮然后报一个看不懂的超时。
 */
/**
 * 起应用并确保**它真的可用**。
 *
 * ## 为什么要"换端口重试"（2026-10-14 加）
 * 这台机器上会出现**成段回环端口对 Electron 的调试服务器不通**的情况
 * （实测：端口开得起来、`DevTools listening on ws://…` 也打了，但 HTTP/WS 握手超时；
 * 同一时刻 9200–9450、9700+ 正常，9500–9650 全挂，而且会随时间变）。
 * 不重试的后果是 `connectOverCDP: connect ETIMEDOUT` —— 读的人只会以为脚本坏了。
 *
 * 关键点：判据必须是**真的问一次 CDP**（`bootOnce` 里的 `/json/version`），
 * 而不是"端口开着"或"用 Node 服务器探一下这个端口" ——
 * 后者会误判（Node 服务器在 9579 上通，Electron 的调试服务器在那里却不答）。
 *
 * @param options 同 `bootOnce`（含 `extraArgs`）；`port` 是首选，不通会就近换（最多 3 个）
 * @returns `bootOnce` 的返回值（`port` 是**实际**用的那个）
 */
export async function bootApp(options) {
  const tried = [];
  let candidate = options.port;
  for (let i = 0; i < 3; i += 1) {
    const booted = await bootOnce({ ...options, port: candidate });
    if (booted.ok) return booted;
    tried.push(candidate);
    try {
      booted.child.kill();
    } catch {
      /* 已经死了就算了 */
    }
    /*
     * 换一个候选：**跳到另一个底座**再挑。
     * 原来写的是 `candidate + 7` —— 实测那一段（9500–9650）会整段不通，
     * 就近换还是会落在坏区间里（三次都失败）。跳底座才能真正换出去。
     */
    const altBase = [9711, 9211, 12311, 14311][i % 4];
    candidate = await pickPort([altBase]);
  }
  return { child: null, port: candidate, ok: false, getLog: () => `试过的端口都不通：${tried.join(" / ")}` };
}

async function bootOnce({ port, dataDir, extraEnv = {}, cwd = ".", timeoutMs = 30000, extraArgs = [] }) {
  const env = { ...process.env, ...extraEnv };
  delete env.ELECTRON_RUN_AS_NODE;
  env.DSH_DEBUG_PORT = String(port);
  if (dataDir) env.DSH_CANVAS_DATA_DIR = dataDir;
  /*
   * `extraArgs`：给"要按不同启动参数跑一遍"的验收用（目前只有 DPI 矩阵：
   * `--force-device-scale-factor=1.25` 这类）。放参数而不是另写一份 spawn ——
   * 起应用这一整套（端口探测、CDP 握手、stderr 读掉防阻塞）就是这个文件存在的理由。
   */
  const child = spawn(
    "node_modules/electron/dist/electron.exe",
    /* 标记开关：清残留时按它认领（G43）——Electron 忽略不认识的开关，落在 process.argv 里 */
    [".", `--remote-debugging-port=${port}`, `${RUN_SWITCH}${ACCEPT_RUN_TAG}`, ...extraArgs],
    {
    cwd,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  /*
   * ⭐ 必须**把 stdout/stderr 读掉**（§137）。
   *
   * 之前是"用 pipe 起进程，但从不读" —— 而这个应用的 stderr 会**刷大量
   * `Gpu Cache Creation failed` 之类的报错**。管道缓冲区（几十 KB）塞满之后，
   * 子进程**写 stderr 时被阻塞**，于是启动卡住、调试端口永远不开 ——
   * 表现出来就是 `ECONNREFUSED`，看的人只会以为"应用坏了"。
   *
   * 报错量随机器状态变（GPU/磁盘缓存），所以这个故障**时好时坏** ——
   * 正是 §119~§122 那个"红名单每次都换"的形态。
   *
   * 这里保留尾部若干字节供诊断用（不打印，避免刷屏）。
   */
  let log = "";
  const cap = (chunk) => {
    log += chunk;
    if (log.length > 16384) log = log.slice(-8192);
  };
  child.stdout?.on("data", (d) => cap(String(d)));
  child.stderr?.on("data", (d) => cap(String(d)));

  /*
   * ⚠️ `ok` 判的是**CDP 真的能握手**，不只是"端口开着"（2026-10-14 修）。
   *
   * 起因：`accept-html` 在本机某个端口上**端口开得起来、`fetch /json/version` 却超时**
   * （`netstat` 能看到那条 TIME_WAIT；同一个应用换 9521 立刻 200）——
   * 于是 `connectOverCDP` 报 `connect ETIMEDOUT`，看着像脚本坏了。
   * 光等端口会把这类失败放进"应用已就绪"里，下一步才炸，而且炸得看不懂。
   * （台机器上这已经是第二次了：9660 那次也是"换个端口就好"。）
   *
   * 所以：先等端口，再**问一次 CDP 的 HTTP 端点** —— 只有它答 200 才算 ok。
   */
  const opened = await waitForPort(port, timeoutMs);
  let ok = false;
  if (opened) {
    const deadline = Date.now() + Math.max(3000, timeoutMs / 3);
    while (Date.now() < deadline) {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1500) });
        if (res.ok) { ok = true; break; }
      } catch {
        /* 端点还没准备好，或者这个端口上的握手在这台机器上根本不通 */
      }
      await new Promise((r) => setTimeout(r, 400));
    }
  }
  return { child, port, ok, getLog: () => log };
}

/**
 * 确保画布是**打开**的（幂等）。
 *
 * ## 为什么要有这个助手（2026-10-14）
 * 画布的入口原来是我自己在右下角加的浮动键；主人指出**本体是把它放在技能面板里**，
 * 于是键撤了、入口改到技能面板的「创建画布」那一条（它在面板里的 testid 仍是
 * `wb-canvas-toggle`，名字不随文案变）。
 *
 * 41 处脚本原来直接点那颗浮动键 —— 现在**必须先开技能面板**。
 * 收敛成这一个助手，比在每个脚本里各写一遍"开面板、等、点"更不容易漂。
 *
 * @param page 页面
 * @returns 画布是否真的开了（调用方据此断言/记录）
 */
/**
 * 读**这个数据目录里所有会话**的记录（走应用的 IPC，不读文件）。
 *
 * ## 为什么要有这个帮手（2026-10-14，Phase 4.3）
 *
 * 有几条验收脚本原来是**直接读 `sessions/*.jsonl`** 的。存储换成 SQLite 之后
 * 那条路永远是空的 —— 于是它们全红，而红的原因是**脚本读错了地方**，
 * 不是产品坏了（`accept-material` / `accept-mcp` 就是这么红的）。
 *
 * 走 IPC 之后，存储再换一次也不用动脚本；而且脚本从此只依赖
 * **应用自己承认的状态**，不依赖"数据摆在哪几个文件里"。
 *
 * ⚠️ 用 `list("all")`：工作台任务的日志是 `task-` 前缀，**从来不在聊天列表里** ——
 * 以前靠"直接读目录"绕过这一点，现在由 `session:list` 的口子把它补上。
 *
 * @param page Playwright 页面
 * @returns 记录数组（所有会话的，按会话顺序拼起来）
 */
export async function readAllSessionRecords(page) {
  return page.evaluate(async () => {
    const list = await window.shell.session.list("all");
    const out = [];
    for (const s of list) {
      const got = await window.shell.session.load(s.sessionId);
      for (const rec of got?.records ?? []) out.push(rec);
    }
    return out;
  });
}

/**
 * 数一数**已经结束的回合**：会话记录里 `done` 的条数。
 *
 * 为什么拿它当终态信号：引擎自己的口径就是一回合以 `done` / `error` 收场
 * （`engine/core/events.test.ts` 钉的就是这个），而记录是**从那条路落下来的**，
 * 不是界面上的观感。见下面 `waitTurnEnd` 的说明。
 *
 * @param page 页面
 * @returns 已结束的回合数
 */
export async function finishedTurns(page) {
  const records = await readAllSessionRecords(page);
  return records.filter((r) => r && r.type === "done").length;
}

/**
 * 等**下一个回合真的结束**（不是"助手气泡出现了"）。
 *
 * ⚠️ 2026-10-16（审计 G108）：`accept-checkpoint.mjs` 与 `accept-compaction.mjs` 等模型那一轮，
 * 原来的判据是「`.wb-assistant-text` 的 count 涨到预期值」再补一个**固定** `waitForTimeout`
 * 就去读正文。真调模型时那是**半截回复**：首 token 出现就算"有了"，尾部长一点、
 * 机器一忙，读到的就是一段没写完的话 —— 而那三条断言（"压缩把关键数字带过去"、
 * "回退之后没有重答"、"历史原样还在"）正是这一批最要紧的证据，慢回答下会变成**假红**，
 * 而 checkpoint/compaction 还会在上一条没结束时就发下一条（会话状态与预期轮次数不再确定）。
 *
 * 按引擎口径，一回合的终态是 `done`/`error`（`events.test.ts` 钉的就是这个），
 * 验收却用一个 DOM 出现当终态 —— 这正是 `engine/core/snapshot.ts` 里点名要淘汰的
 * 「等 300ms 不够就红」形态。所以这里改成等记录里的 `done`：确定、可判定、与产品同一套真相。
 *
 * 用法：**发之前**先取 `before = await finishedTurns(page)`，发完 `await waitTurnEnd(page, before)`。
 *
 * @param page 页面
 * @param before 发之前那一轮的已结束回合数
 * @param timeoutMs 等多久算不可达（默认 3 分钟：真模型长回答也要容得下）
 * @returns 结束后的回合数
 */
export async function waitTurnEnd(page, before, timeoutMs = 180_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const now = await finishedTurns(page);
    if (now > before) return now;
    if (Date.now() > deadline) {
      throw new Error(`这一轮 ${Math.round(timeoutMs / 1000)} 秒内没结束（会话记录里没等到 done）—— 别拿半截回复去判`);
    }
    await page.waitForTimeout(300);
  }
}

/**
 * 进「插件·技能·伙伴」页（**新的入口**，2026-10-16）。
 *
 * 左栏那个 `wb-nav-plugins` 导航项被拆了（导航收敛成 三项），现在走：
 * 输入区「技能」下拉 → 「技能管理」（与本体口径一致：直接进管理子页）。
 * 7 条验收脚本原来都点那个已经不存在的 testid —— 它们红的是**脚本过期**，不是产品坏了。
 *
 * @param page 页面
 * @returns 插件页是否真的打开了
 */
export async function openPluginsPage(page, { market = false } = {}) {
  const onMarket = async () => (await page.locator('[data-testid="wb-page-plugins"]').count()) > 0;
  const onManage = async () => (await page.locator('[data-testid="wb-page-plugins-manage"]').count()) > 0;
  if (market ? await onMarket() : await onManage()) return true;
  if (!(await onMarket()) && !(await onManage())) {
    await page.locator('[data-testid="wb-skills"]').click();
    await page.waitForTimeout(600);
    await page.getByText("技能管理", { exact: true }).first().click();
    await page.waitForTimeout(1200);
  }
  /*
   * 「技能管理」进的是**管理子页**（`wb-page-plugins-manage`），
   * 而搜索与市场在**市场页**（`wb-page-plugins`）——两者是两套标签
   * （管理用 `wb-manage-tab-*`，市场用 `wb-plugin-tab-*`）。要市场的回到市场。
   */
  if (market && !(await onMarket())) {
    const crumb = page.locator('[data-testid="wb-crumb-market"]');
    if ((await crumb.count()) > 0) {
      await crumb.click();
      await page.waitForTimeout(900);
    }
  }
  return market ? onMarket() : onManage();
}

export async function openCanvas(page) {
  if ((await page.locator('[data-testid="wb-canvas"]').count()) > 0) return true;
  if ((await page.locator('[data-testid="wb-skill-panel"]').count()) === 0) {
    await page.locator('[data-testid="wb-skills"]').click();
    await page.waitForTimeout(600);
  }
  await page.locator('[data-testid="wb-canvas-toggle"]').click();
  /* 画布是条件渲染的重组件，起来要一会儿（原来那颗浮动键也是等 ~2.2s）。 */
  await page.waitForTimeout(2400);
  return (await page.locator('[data-testid="wb-canvas"]').count()) > 0;
}

/** 确保画布是**收起**的（幂等）；已经收起就直接返回。 */
export async function closeCanvas(page) {
  if ((await page.locator('[data-testid="wb-canvas"]').count()) === 0) return true;
  if ((await page.locator('[data-testid="wb-skill-panel"]').count()) === 0) {
    await page.locator('[data-testid="wb-skills"]').click();
    await page.waitForTimeout(600);
  }
  await page.locator('[data-testid="wb-canvas-toggle"]').click();
  await page.waitForTimeout(1200);
  return (await page.locator('[data-testid="wb-canvas"]').count()) === 0;
}

/**
 * 展开右侧「对话摘要」面板（幂等）—— 右栏已经展开就直接返回。
 *
 * ## 为什么要有它（2026-10-14）
 * 右栏从这天起**默认收起**（照 Ding Harness 原型的口径：塌成右缘一条竖直把手 `wb-summary-expand`，
 * 点开才展开），而**4 条脚本原来直接点 `wb-summary-tab-*`**
 * （`accept-artifacts` / `accept-emptystates` / `accept-media` / `accept-workbench`）。
 * 不先展开，它们会一起红。
 *
 * 与 `openCanvas` 同一个理由：**别让 4 处各写一遍"先展开再点"** —— 写四遍就会漂
 * （画布那次就是 41 处各写一遍，最后收敛成 `openCanvas`）。
 *
 * @param page 页面
 * @returns 面板是否处于展开态
 */
export async function openSummary(page) {
  const aside = page.locator('[data-testid="wb-summary"]');
  if ((await aside.count()) === 0) return false;
  const isCollapsed = () => aside.first().evaluate((el) => el.classList.contains("is-collapsed"));
  if (!(await isCollapsed())) return true;
  const handle = page.locator('[data-testid="wb-summary-expand"]');
  if ((await handle.count()) === 0) return false;
  await handle.first().click();
  await page.waitForTimeout(400);
  return !(await isCollapsed());
}

/**
 * 连 CDP，失败**重试几次**（2026-10-14）。
 *
 * 这台机器上偶发 `connectOverCDP` 抖动：HTTP 端点答得出来、WebSocket 却
 * `ETIMEDOUT`，或者连上后立刻 `code=1006` 断开。这类抖动不该判脚本死刑，
 * 也不该被当成"产品坏了" —— 用这个助手包一层。
 *
 * ⚠️ 但**同一个端口**上反复 1006 时，重试救不了（那是这个端口的 WS 路径坏了）——
 * 那种情况要看 `openApp`（它会换端口重来）。
 *
 * @param browserType Playwright 的 `chromium`
 * @param url `http://127.0.0.1:<port>`
 * @param attempts 最多试几次
 * @returns 连上的 browser
 */
export async function connectWithRetry(browserType, url, attempts = 8) {
  let last = null;
  for (let i = 0; i < attempts; i += 1) {
    try {
      return await browserType.connectOverCDP(url);
    } catch (error) {
      last = error;
      await new Promise((r) => setTimeout(r, 1200));
    }
  }
  throw last;
}

/**
 * 起应用**并连上**（换端口重试）—— 新写验收直接用这个。
 *
 * ## 为什么"boot 成功"还不够（2026-10-14 实测出来的三层坑）
 *   ① `connectOverCDP` 连 HTTP 都超时（`ETIMEDOUT`）；
 *   ② HTTP 端点答 200、**WebSocket 却立刻 `code=1006` 断开**（同一端口重试 4 次全挂）；
 *   ③ **Node 服务器在同一个端口上好好的** —— 所以"探一下这个端口通不通"**预测不了 Electron**。
 *
 * 结论：能不能用**只能以 Playwright 真连一次为准**。于是把"起 + 连"当一个整体：
 * 连不上就杀掉、换一个底座端口重来（最多 3 个端口）。
 *
 * @param chromium Playwright 的 `chromium`
 * @param options 同 `bootApp`（含 `extraArgs`：给按不同启动参数各跑一遍的验收，如 DPI 矩阵；`port` 是首选，连不上会换）
 * @returns `{ browser, page, child, port, getLog }`
 */
export async function openApp(chromium, options) {
  const tried = [];
  let candidate = options.port;
  const altBases = [9711, 9211, 12311];
  for (let i = 0; i < 3; i += 1) {
    const booted = await bootApp({ ...options, port: candidate });
    if (booted.ok) {
      try {
        const browser = await connectWithRetry(chromium, `http://127.0.0.1:${booted.port}`, 2);
        const page = await waitForPage(browser);
        return { browser, page, child: booted.child, port: booted.port, getLog: booted.getLog };
      } catch {
        /* 连不上：这个端口对 Playwright 不算数 */
      }
    }
    tried.push(candidate);
    try {
      booted.child?.kill();
    } catch {
      /* 已经死了 */
    }
    candidate = await pickPort([altBases[i % altBases.length]]);
  }
  throw new Error(`换了三个端口都起不来 / 连不上（试过：${tried.join(" / ")}）—— 这台机器的端口状态要看一眼`);
}

/**
 * 挑一个**真的能用**的回环端口（2026-10-14）。
 *
 * ## 为什么需要（这台机器的环境坑，实测过）
 * 有些回环端口对**任何进程**都不通：起得了监听、连不上（`netstat` 里能看到
 * `SYN_RECEIVED`）。实测对照：
 * ```
 * 9521 → 通     9555 → 不通     9577 → 不通     9799 → 通
 * ```
 * 用的是同一个极简 `http.createServer().listen(p, "127.0.0.1")` + `fetch`，
 * 所以与脚本、与 Electron 都无关 —— 是机器状态（大概率是安全软件/防火墙把这些端口挂了）。
 *
 * 不挑的后果很难看：`connectOverCDP` 报 `connect ETIMEDOUT`，
 * 读的人只会以为"脚本/产品坏了"，而真相是"这个端口在这台机器上不通"。
 *
 * @param candidates 候选端口（按顺序试）
 * @returns 第一个能"起监听 + 连得上"的端口
 * @throws 全部候选都不通时抛错（这种情况要看机器，不是改脚本）
 */
export async function pickPort(candidates) {
  const list = Array.isArray(candidates) ? candidates : [candidates];
  const { createServer } = await import("node:http");
  for (const port of list) {
    const usable = await new Promise((resolve) => {
      const srv = createServer((_req, res) => res.end("ok"));
      srv.on("error", () => resolve(false));
      srv.listen(port, "127.0.0.1", async () => {
        try {
          /*
           * ⚠️ 超时 400ms 而不是 2 秒（2026-10-14）：回环连接要么**瞬间**成功、
           * 要么**永远**不通（死端口会一直等到超时）。用 2 秒的话，
           * 一台机器上有一整段死端口时，每条验收在挑端口上就要多花 ~20 秒 ——
           * 实测批跑因此从 ~40 秒/条 变成 ~4.5 分钟/条。
           */
          const res = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(400) });
          resolve(res.ok);
        } catch {
          resolve(false);
        } finally {
          srv.close();
        }
      });
    });
    if (usable) return port;
  }
  /*
   * 首选都不通就**换几段扫描**：这台机器上实测是"**整段**不通"
   * （9500–9650 全挂，9200–9450 / 9700+ 正常，而且会随时间变），
   * 所以只往后顺延是没用的（可能一路都在坏区间里）——
   * 改成"就近顺延 → 换几个不同基数再扫"。
   *
   * ⚠️ 但这条判据**预测不了 Electron**：同一个端口，Node 服务器探着通、
   * Electron 的调试服务器却握手超时（9561 实测）。真正的判据是 `bootApp` 里那次
   * CDP 询问 —— 所以它**也会**换端口重试（见 `bootApp`）。
   */
  const bases = [list[list.length - 1] + 1, 9211, 9711, 12311, 14311];
  for (const base of bases) {
    for (let port = base; port < base + 20; port += 1) {
      const usable = await new Promise((resolve) => {
        const srv = createServer((_req, res) => res.end("ok"));
        srv.on("error", () => resolve(false));
        srv.listen(port, "127.0.0.1", async () => {
          try {
            const res = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(400) });
            resolve(res.ok);
          } catch {
            resolve(false);
          } finally {
            srv.close();
          }
        });
      });
      if (usable) return port;
    }
  }
  throw new Error(`这些端口以及几段兜底候选都不通：${list.join(" / ")}（这台机器的端口状态要看一眼）`);
}

/** 一条验收的标准判定：把 bad 列表收敛成退出码与判词。 */
export function verdict(bad, okText) {
  if (bad.length) {
    console.error("✗ " + bad.join("；"));
    process.exitCode = 1;
    return;
  }
  console.log("✓ " + okText);
}

/**
 * 读一个"落盘实体"文件（`memory.json` / `docs.json` / `tasks.json` …）并**脱掉信封**。
 *
 * ## 为什么需要它（C1，2026-10-13）
 *
 * 这些文件原来是**裸 JSON**（`JSON.stringify(业务数据)`），各模块自己读自己写，
 * 于是同一条保证在每个模块里的强度都不一样：内存库连原子写都没有、**一处都不重试**、
 * 只有画布有版本号而那是个装饰品。C1 把落盘收成一份（`electron/ipc/jsonStore.ts`），
 * 顺带加上**信封 + 版本 + 前向迁移**：
 *
 * ```json
 * { "__schema": 1, "data": { ...原来那些东西... } }
 * ```
 *
 * ⚠️ 于是**验收脚本必须脱信封之后再断言**。断言的对象是"用户的东西有没有真的存下来"，
 * 不是"它躺在 JSON 的第几层"——把断言绑在层数上，等于以后每加一个信封就红一片。
 *
 * 同时兼容**没有信封的旧文件**（裸数据），所以同一段代码对两种磁盘格式都成立 ——
 * 这也是产品侧那条硬要求（旧数据必须能读）在验收侧的对偶。
 *
 * ⚠️ **不要**拿它读画布快照（`canvas.json` / `rev-N.json`）：那些文件**没有信封**，
 * 它们的 `version` 是画布文档自己的格式版本（见 `shared/canvas.ts` 的 `migrateCanvasDoc`）。
 *
 * @param {string} file 文件路径
 * @returns 里面的业务数据（信封拆掉之后）
 */
export function readStoreFile(file) {
  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  const enveloped =
    raw !== null && typeof raw === "object" && !Array.isArray(raw) && typeof raw.__schema === "number" && "data" in raw;
  return enveloped ? raw.data : raw;
}

/**
 * **自动回答应用内确认框**（2026-10-19，主人点名）。
 *
 * ## 为什么需要
 *
 * CUA 授权与每次动作确认现在是**应用内模态**（不再是系统弹窗），默认焦点在「取消」上 ——
 * 对真用户是对的，但验收脚本会**卡在那儿等人点**。主人原话：
 * "你就不能把设置成完全允许吗 非得让我一个个手动帮你去点吗"。
 *
 * 这条 helper 在后台轮询：一出现 `[data-testid="wb-confirm-dialog"]` 就点确认，
 * 直到被 `stop()`。它不是"绕过审批"——**审批本身照旧发生了**（对话框真的画了、真的点了），
 * 只是点击由脚本代劳，与真人的操作路径完全一致。
 *
 * ⚠️ 只在**验收**里用。产品里没有这个自动点击，用户的确认永远是真的。
 *
 * @param page 页面
 * @returns `stop()` 停止轮询
 */
export function autoConfirmDialogs(page) {
  let stopped = false;
  const loop = (async () => {
    while (!stopped) {
      try {
        const ok = page.locator('[data-testid="wb-confirm-ok"]');
        if ((await ok.count()) > 0) {
          await ok.first().click({ timeout: 2000 });
          await page.waitForTimeout(200);
          continue;
        }
      } catch {
        /* 页面正在切换/关闭：下一轮再看 */
      }
      await page.waitForTimeout(300);
    }
  })();
  return {
    stop: () => {
      stopped = true;
      void loop;
    },
  };
}
