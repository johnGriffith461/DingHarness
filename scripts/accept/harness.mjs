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
 * @param options 同 `bootOnce`；`port` 是首选，不通会就近换（最多 3 个）
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

async function bootOnce({ port, dataDir, extraEnv = {}, cwd = "D:/DoubaoWorkClone", timeoutMs = 30000 }) {
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
 * 右栏从这天起**默认收起**（照 Dingwork 原型的口径：塌成右缘一条竖直把手 `wb-summary-expand`，
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
 * @param options 同 `bootApp`（`port` 是首选，连不上会换）
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
