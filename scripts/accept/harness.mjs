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
 * ⚠️ 只杀 electron.exe / 工作台.exe —— **不要**按 `DoubaoWork` 杀：
 * 那是**用户本体的进程**（我这边是复刻版，进程名不同）。
 */

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** 现在还活着的 electron / 工作台 进程数。 */
export function leftoverCount() {
  const r = spawnSync("tasklist", ["/FI", "IMAGENAME eq electron.exe", "/NH"], { encoding: "utf8" });
  const s = r.stdout ?? "";
  const n = /no tasks|没有运行|信息: 没有/i.test(s) ? 0 : (s.match(/electron\.exe/gi) ?? []).length;
  const w = spawnSync("tasklist", ["/FI", "IMAGENAME eq 工作台.exe", "/NH"], { encoding: "utf8" });
  const ws = w.stdout ?? "";
  const wn = /no tasks|没有运行|信息: 没有/i.test(ws) ? 0 : (ws.match(/工作台\.exe/gi) ?? []).length;
  return n + wn;
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
 * ⚠️ 只杀 electron.exe / 工作台.exe —— **不要**按 `DoubaoWork` 杀：
 * 那是**用户本体的进程**（我这边是复刻版，进程名不同）。
 */
export async function killLeftovers({ budgetMs = 12000 } = {}) {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    spawnSync("taskkill", ["/F", "/IM", "electron.exe", "/T"], { stdio: "ignore" });
    spawnSync("taskkill", ["/F", "/IM", "工作台.exe", "/T"], { stdio: "ignore" });
    await sleep(450);
    if (leftoverCount() === 0) {
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
export async function bootApp({ port, dataDir, extraEnv = {}, cwd = "D:/DoubaoWorkClone", timeoutMs = 30000 }) {
  const env = { ...process.env, ...extraEnv };
  delete env.ELECTRON_RUN_AS_NODE;
  env.DSH_DEBUG_PORT = String(port);
  if (dataDir) env.DSH_CANVAS_DATA_DIR = dataDir;
  const child = spawn("D:/DoubaoWorkClone/node_modules/electron/dist/electron.exe", [".", `--remote-debugging-port=${port}`], {
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

  const ok = await waitForPort(port, timeoutMs);
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
