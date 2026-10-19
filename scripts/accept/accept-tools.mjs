import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";
import { bootApp, connectWithRetry, freshDir, killTree, readStoreFile, shot } from "./harness.mjs";

/**
 * 验收：**工具协议端到端**（§141）。
 *
 * 这是唯一能证明"工具真的能用"的方式 —— 前几层（声明、schema、事件转发）都可以靠单测，
 * 但"模型真的调了、真的落到盘上"只能真跑一次。
 *
 * ⚠️ **这条会真调模型**（约 30~60 秒）。所以它**不进无模型批跑**，单独跑。
 *
 * 断言分两层（缺一不可）：
 *   ① 界面：这一步下面出现工具留痕（`⚙ 记忆：已保存…`）
 *   ② **磁盘**：`<dataDir>/memory.json` 里真的有那条内容
 *
 * 只断言 ① 是不够的 —— 界面那行小字是渲染出来的，写盘失败它照样能显示。
 * 只断言 ② 也是不够的 —— 那就说明不了"用户看得见"。
 */
const DATA = ".verify/tools-data";
if (!(await freshDir(DATA))) {
  console.error("✗ 数据目录 " + DATA + " 删不掉 —— 先手工关掉占着它的 Electron");
  process.exit(1);
}

const MEMO_TEXT = "我的店铺叫青山茶叶";
/** 语义锚点：只要求这个关键名词到了，不要求模型逐字照抄（见下面关于误红的注释）。 */
const MEMO_KEY = "青山茶叶";
/*
 * ⚠️ 闸门那句的关键名词**必须在模块作用域**。
 * 它原来声明在下面 try 块里（块作用域），却在 finally 的失败报告里被引用 ——
 * 于是**闸门真的没拦住时，脚本先抛 ReferenceError**，把「没拦住」这个真问题
 * 盖成一个看不懂的报错（而那恰恰是脚本最该说实话的那条路径）。
 *
 * 2026-10-13 由 `pnpm lint` 的 no-undef 抓出来 —— 那是 B5 把验收脚本从被 gitignore 的
 * .verify/ 搬进版本库、第一次被 lint 覆盖之后。这就是「纳入版本库」的即期收益。
 */
const GATE_KEY = "快递";
/* ⚠️ 2026-10-16（审计 G06/G07）：bootApp 会换端口重试 —— 下面用的是它返回的实际端口，不再假设给哪个就用哪个 */
let PORT = 9293;
const booted = await bootApp({ port: PORT, dataDir: DATA, timeoutMs: 30000 });
const { child, ok, getLog } = booted;
/* 用实际端口（bootApp 换过端口时它与首选不同） */
PORT = booted.port;
if (!ok) {
  console.error("[诊断] 应用输出尾部：\n" + (getLog() || "(空)").slice(-1200));
  await killTree(child);
  process.exit(1);
}

const out = {};
try {
  const b = await connectWithRetry(chromium, `http://127.0.0.1:${PORT}`);
  const page = b.contexts()[0].pages().find((p) => !p.url().startsWith("devtools://"));
  await page.waitForSelector('[data-testid="wb"]', { timeout: 20000 });
  await page.waitForTimeout(2000);

  /*
   * ⚠️ 第一阶段的档位设成**全部允许**（2026-10-16，收进批跑时补）。
   *
   * 第一阶段断的是"模型调了工具 **且磁盘上真有结果**"—— 而默认档位（按需确认）会把
   * 这个写动作拦成「等你确认（还没执行）」：工具没执行、memory.json 也就没生成，
   * 于是那三条断言必然红，红的原因还与"工具协议通不通"无关。
   * 闸门本身在第二~四阶段验（那里**故意**切到「每步确认」并走允许 / 拒绝两条路）。
   */
  await page.evaluate(() => localStorage.setItem("dsh-canvas.confirm-mode", "全部允许"));
  await page.reload();
  await page.waitForSelector('[data-testid="wb"]', { timeout: 20000 });
  await page.waitForTimeout(1000);

  /*
   * 话术刻意写得**明确指向工具**：这条验收测的是"工具通不通"，
   * 不是在测"模型能不能猜到该用工具"。后者是另一个问题（提示词工程），
   * 混在一起会让这条验收时红时绿。
   */
    /* 任务视图现在会"接着聊"（§147），所以每个阶段先回首页，让这一段仍是独立的一次发起 */
  await page.locator('[data-testid="wb-nav-home"]').click();
  await page.waitForTimeout(900);
await page.locator('[data-testid="wb-composer-input"]').fill(`请调用 memory_save 工具记住这一条：${MEMO_TEXT}`);
  await page.locator('[data-testid="wb-send"]').click();

  // 等那一步落下来（模型调工具 + 收尾，给足时间）
  const deadline = Date.now() + 120000;
  let toolBox = null;
  while (Date.now() < deadline) {
    await page.waitForTimeout(2000);
    const box = await page.evaluate(() => {
      const el = document.querySelector('[class*="wb-assistant-tools"]');
      return el ? { text: el.textContent?.trim() ?? "", count: el.querySelectorAll(".wb-tool-line").length } : null;
    });
    if (box) {
      toolBox = box;
      break;
    }
  }

  out.toolLines = toolBox;
  out.transcript = await page.evaluate(() =>
    Array.from(document.querySelectorAll(".wb-assistant-text")).map((e) => (e.textContent ?? "").slice(0, 120)),
  );

  // 磁盘证据（与界面证据分开取，避免"界面显示了就算过"）
  const memFile = path.join(DATA, "memory.json");
  out.memoryFileExists = fs.existsSync(memFile);
  if (out.memoryFileExists) {
    const raw = fs.readFileSync(memFile, "utf8");
    out.memoryOnDisk = readStoreFile(memFile);
    /*
     * ⚠️ 判据是**语义锚点**（那个关键名词），不是逐字比对。
     *
     * 第一版我比的是整句「我的店铺叫青山茶叶」，结果**误红了** ——
     * 模型把它改写成「用户的店铺叫青山茶叶」「用户的店铺叫「青山茶叶」。」存了进去。
     * 那是模型的正常行为（它按自己的措辞整理），不是工具坏了。
     *
     * **教训（带模型的验收通则）**：只要链路里有 LLM，断言就必须落在
     * "意思有没有到"上，而不是"字面一模一样"。逐字比对会把模型的改写当成失败。
     */
    out.memoryHasKey = raw.includes(MEMO_KEY);
    out.memoryEntries = Array.isArray(out.memoryOnDisk?.entries) ? out.memoryOnDisk.entries.length : 0;
    out.allFromConversation = (out.memoryOnDisk?.entries ?? []).every((e) => e?.source === "conversation");
  }

  out.shot = await shot(page, "tools.png");

  /* ============================================================
   * 第二阶段：审批闸门（§143）
   *
   * 切到「每步确认」再发一条**新的**记忆请求，然后断言：
   *   ① 界面上的留痕写的是「等你确认（还没执行）」，不是「已保存」；
   *   ② **磁盘上确实没有**那条内容 —— 这才叫"拦住了"。
   *
   * 用一句**全新**的内容（快递那句）而不是重复第一句：第一句已经进过库，
   * 拿它验"没写进去"会必然失败（它本来就在）。
   * ============================================================ */
  const GATE_TEXT = "我的快递默认寄到公司";

  await page.locator('[data-testid="wb-confirm"]').click();
  await page.waitForTimeout(500);
  await page.locator('[data-testid="wb-confirm-option-每步确认"]').click();
  await page.waitForTimeout(600);
  out.gateModeChip = await page.evaluate(
    () => document.querySelector('[data-testid="wb-confirm"]')?.textContent?.trim() ?? null,
  );

  /* 发之前先数一次条数 —— 这样"多出来的那条"归谁就一目了然（诊断用，§143）。 */
  const readEntries = () => {
    try {
      return readStoreFile(path.join(DATA, "memory.json")).entries ?? [];
    } catch {
      return [];
    }
  };
  out.beforeGateSend = readEntries().map((e) => e.text);

    /* 任务视图现在会"接着聊"（§147），所以每个阶段先回首页，让这一段仍是独立的一次发起 */
  await page.locator('[data-testid="wb-nav-home"]').click();
  await page.waitForTimeout(900);
await page.locator('[data-testid="wb-composer-input"]').fill(`请调用 memory_save 工具记住这一条：${GATE_TEXT}`);
  await page.locator('[data-testid="wb-send"]').click();

  const gateDeadline = Date.now() + 120000;
  let gateLine = null;
  while (Date.now() < gateDeadline) {
    await page.waitForTimeout(2000);
    gateLine = await page.evaluate(() => {
      const lines = Array.from(document.querySelectorAll(".wb-tool-line")).map((e) => e.textContent?.trim() ?? "");
      return lines.find((t) => t.includes("等你确认")) ?? null;
    });
    if (gateLine) break;
  }
  out.gateLine = gateLine;

  /* 多等一会，把"这一步里还有没有别的工具调用"收全（诊断）。 */
  await page.waitForTimeout(6000);
  out.allToolLines = await page.evaluate(() =>
    Array.from(document.querySelectorAll(".wb-tool-line")).map((e) => e.textContent?.trim() ?? ""),
  );
  out.afterGateSend = readEntries().map((e) => e.text);

  const gateMem = fs.existsSync(path.join(DATA, "memory.json"))
    ? fs.readFileSync(path.join(DATA, "memory.json"), "utf8")
    : "";
  out.gateWroteNothing = !gateMem.includes(GATE_KEY);
  out.gateEntries = gateMem ? (readStoreFile(path.join(DATA, "memory.json")).entries?.length ?? 0) : 0;

  out.gateShot = await shot(page, "tools-gate.png");

  /* ============================================================
   * 第三阶段：点「允许」——放行之后**必须真的执行**（§144）
   * ============================================================ */
  const ALLOW_TEXT = "我的健身房在小区东门";
  const ALLOW_KEY = "健身房";

    /* 任务视图现在会"接着聊"（§147），所以每个阶段先回首页，让这一段仍是独立的一次发起 */
  await page.locator('[data-testid="wb-nav-home"]').click();
  await page.waitForTimeout(900);
await page.locator('[data-testid="wb-composer-input"]').fill(`请调用 memory_save 工具记住这一条：${ALLOW_TEXT}`);
  await page.locator('[data-testid="wb-send"]').click();

  const allowBtn = page.locator('[data-testid^="wb-tool-allow-"]').first();
  await allowBtn.waitFor({ timeout: 120000 });
  await page.waitForTimeout(500);
  out.allowBtnSeen = true;
  await allowBtn.click();
  await page.waitForTimeout(2500);
  out.allowLine = await page.evaluate(() => {
    const lines = Array.from(document.querySelectorAll(".wb-tool-line")).map((e) => e.textContent?.trim() ?? "");
    return lines.find((t) => t.includes("记忆")) ?? null;
  });
  out.allowWrote = readEntries().some((e) => String(e.text).includes(ALLOW_KEY));
  out.allowShot = await shot(page, "tools-allow.png");

  /* ============================================================
   * 第四阶段：点「拒绝」——**磁盘不许动**（§144）
   * ============================================================ */
  const DENY_TEXT = "孩子的英语课在周三晚上";
  const DENY_KEY = "英语课";

    /* 任务视图现在会"接着聊"（§147），所以每个阶段先回首页，让这一段仍是独立的一次发起 */
  await page.locator('[data-testid="wb-nav-home"]').click();
  await page.waitForTimeout(900);
await page.locator('[data-testid="wb-composer-input"]').fill(`请调用 memory_save 工具记住这一条：${DENY_TEXT}`);
  await page.locator('[data-testid="wb-send"]').click();

  const denyBtn = page.locator('[data-testid^="wb-tool-deny-"]').first();
  await denyBtn.waitFor({ timeout: 120000 });
  await page.waitForTimeout(500);
  out.denyBtnSeen = true;
  await denyBtn.click();
  await page.waitForTimeout(2000);
  out.denyLine = await page.evaluate(() => {
    const lines = Array.from(document.querySelectorAll(".wb-tool-line")).map((e) => e.textContent?.trim() ?? "");
    return lines.find((t) => t.includes("拒绝")) ?? null;
  });
  out.denyWroteNothing = !readEntries().some((e) => String(e.text).includes(DENY_KEY));
  out.denyShot = await shot(page, "tools-deny.png");

  /* ============================================================
   * 第五阶段：定时任务工具（§145）
   *
   * 这一段同时压三件事：**新工具**（schedule_create）+ **闸门**（每步确认 → 点允许）
   * + **落盘与界面**（schedules.json 与定时任务页都要有）。
   * ============================================================ */
  const JOB_TITLE = "每日行业新闻";

  await page
    .locator('[data-testid="wb-composer-input"]')
    .fill(`请调用 schedule_create 工具，每天 9 点提醒我看行业新闻，标题就叫「${JOB_TITLE}」`);
  await page.locator('[data-testid="wb-send"]').click();

  const jobAllow = page.locator('[data-testid^="wb-tool-allow-"]').first();
  await jobAllow.waitFor({ timeout: 120000 });
  await page.waitForTimeout(400);
  await jobAllow.click();
  /*
   * 2026-10-20：原来固定等 2.5s —— 放行之后这次工具调用的留痕在批跑机器上
   * 偶尔还没渲染出来（磁盘已经写了，界面读早了）。改成轮询到那一行出现。
   */
  const jobDeadline = Date.now() + 15_000;
  while (Date.now() < jobDeadline) {
    out.jobLine = await page.evaluate(() => {
      const lines = Array.from(document.querySelectorAll(".wb-tool-line")).map((e) => e.textContent?.trim() ?? "");
      return lines.find((t) => t.includes("定时任务")) ?? null;
    });
    if (out.jobLine) break;
    await page.waitForTimeout(500);
  }
  /* 诊断用：失败时能看到这一步到底有哪些留痕（不是只报 null） */
  out.jobAllLines = await page.evaluate(() =>
    Array.from(document.querySelectorAll(".wb-tool-line")).map((e) => e.textContent?.trim().slice(0, 80) ?? ""),
  );

  const schedFile = path.join(DATA, "schedules.json");
  out.schedulesFileExists = fs.existsSync(schedFile);
  out.schedulesOnDisk = out.schedulesFileExists ? readStoreFile(schedFile) : [];
  out.jobOnDisk = out.schedulesOnDisk.some((j) => String(j?.title ?? "").includes(JOB_TITLE));

  /* 界面：进定时任务页，应当能看见刚建的那条（页面挂载时会 load） */
  await page.locator('[data-testid="wb-nav-scheduled"]').click();
  await page.waitForTimeout(2500);
  out.jobVisible = await page.evaluate(
    (title) => (document.querySelector('[data-testid="wb-sched-list"]')?.textContent ?? "").includes(title),
    JOB_TITLE,
  );
  out.jobShot = await shot(page, "tools-schedule.png");

  /* ============================================================
   * 第六阶段：画布节点工具（§146）
   *
   * 这一段压的是**跨进程那条路**：工具在主进程 → 发命令 → 渲染进程动手 → 回执。
   * 所以断言必须落在**画布 DOM**上（节点真的出现了），而不是只看留痕。
   * 顺带验"画布没开时会自动打开"。
   * ============================================================ */
  const NODE_MARK = "今日待办";

  await page.locator('[data-testid="wb-nav-home"]').click();
  await page.waitForTimeout(1200);
  out.canvasBefore = await page.locator(".react-flow__node").count();

  await page
    .locator('[data-testid="wb-composer-input"]')
    .fill(`请调用 canvas_add_node 工具，在画布上加一个 markdown 节点，内容写「${NODE_MARK}：复刻画布」`);
  await page.locator('[data-testid="wb-send"]').click();

  const nodeAllow = page.locator('[data-testid^="wb-tool-allow-"]').first();
  await nodeAllow.waitFor({ timeout: 120000 });
  await page.waitForTimeout(400);
  await nodeAllow.click();
  /*
   * 2026-10-20：原来固定等 3s —— 首次打开画布要载入示例文档（6 个节点），
   * 批跑机器上会超过 3s，于是"节点没出现"是**读得太早**，不是没加。
   * 改成轮询到节点出现（最多 20s；超时仍然如实红）。
   */
  const nodeByMark = () =>
    page.evaluate((mark) => {
      return Array.from(document.querySelectorAll(".react-flow__node")).some((e) =>
        (e.textContent ?? "").includes(mark),
      );
    }, NODE_MARK);
  const nodeDeadline = Date.now() + 20_000;
  while (Date.now() < nodeDeadline) {
    if (await nodeByMark()) break;
    await page.waitForTimeout(500);
  }

  out.canvasOpen = (await page.locator('[data-testid="wb-canvas"]').count()) > 0;
  out.canvasAfter = await page.locator(".react-flow__node").count();
  /*
   * ⚠️ 必须在**所有**节点里找那句话，不能只看第一个。
   *
   * 画布打开时会加载一份**示例文档**（6 个节点），新加的那个排在后面 ——
   * 第一版我取的是 `.react-flow__node` 的第一个，于是拿到的是示例里的「使用说明」，
   * 功能明明对了却报红。
   */
  out.canvasNodeTexts = await page.evaluate(() =>
    Array.from(document.querySelectorAll(".react-flow__node")).map((e) => (e.textContent ?? "").slice(0, 60)),
  );
  out.canvasHasOurNode = out.canvasNodeTexts.some((t) => t.includes("今日待办"));
  out.canvasLine = await page.evaluate(() => {
    const lines = Array.from(document.querySelectorAll(".wb-tool-line")).map((e) => e.textContent?.trim() ?? "");
    return lines.find((t) => t.includes("画布")) ?? null;
  });
  out.canvasShot = await shot(page, "tools-canvas.png");

  await b.close();
} catch (e) {
  out.error = String(e).slice(0, 260);
} finally {
  console.log(JSON.stringify(out, null, 2));
  await killTree(child);

  const bad = [];
  if (!out.toolLines) bad.push("界面上没有出现工具留痕（这一步没记下任何工具调用）");
  else if (!out.toolLines.text.includes("记忆")) bad.push(`工具留痕里没提「记忆」：${out.toolLines.text}`);
  if (!out.memoryFileExists) bad.push("memory.json 根本没生成 —— 工具没真的写盘");
  else if (!out.memoryHasKey) bad.push(`memory.json 里没有关键名词「${MEMO_KEY}」`);
  else if (!(out.memoryEntries >= 1)) bad.push("memory.json 里一条都没有");
  else if (!out.allFromConversation) bad.push("落盘的条目标成了非 conversation 来源（工具存的应当带 conversation）");

  /* ── 审批闸门（第二阶段）── */
  if (!(out.gateModeChip ?? "").includes("每步确认")) bad.push(`档位没切成「每步确认」（chip 上是 ${out.gateModeChip}）`);
  if (!out.gateLine) bad.push("切到「每步确认」后，界面没有出现「等你确认」的留痕");
  if (!out.gateWroteNothing) bad.push(`⚠️ 闸门没拦住：磁盘上出现了「${GATE_KEY}」—— 说明写着"要确认"却已经把事做了`);

  /* ── 放行与拒绝（第三、四阶段）── */
  if (!out.allowBtnSeen) bad.push("被拦下时没有出现「允许」按钮（闸门只拦不放，是半步）");
  else {
    if (!out.allowWrote) bad.push("点了「允许」但磁盘上没出现那条记忆 —— 放行是假的");
    if (!(out.allowLine ?? "").includes("已保存")) bad.push(`放行后留痕没变成已保存：${out.allowLine}`);
  }
  if (!out.denyBtnSeen) bad.push("被拦下时没有出现「拒绝」按钮");
  else {
    if (!out.denyWroteNothing) bad.push("点了「拒绝」磁盘上却出现了那条记忆 —— 拒绝没生效");
    if (!(out.denyLine ?? "").includes("拒绝")) bad.push(`拒绝后留痕没写「你已拒绝」：${out.denyLine}`);
  }

  /* ── 定时任务工具（第五阶段）── */
  if (!(out.jobLine ?? "").includes("定时任务")) bad.push(`建任务的留痕不对：${out.jobLine}`);
  if (!out.schedulesFileExists) bad.push("schedules.json 没生成 —— 定时任务工具没真的写盘");
  else if (!out.jobOnDisk) bad.push(`schedules.json 里没有「${"每日行业新闻"}」`);
  if (!out.jobVisible) bad.push("定时任务页上看不到刚建的那条（写盘了但界面没跟上）");

  /* ── 画布节点工具（第六阶段）── */
  if (!out.canvasOpen) bad.push("画布没有自动打开（工具要求：画布没开就自动打开）");
  if (!(out.canvasAfter > out.canvasBefore)) {
    bad.push(`画布上没有多出节点（前 ${out.canvasBefore} / 后 ${out.canvasAfter}）`);
  }
  if (!out.canvasHasOurNode) bad.push(`画布上没有那个节点：${JSON.stringify(out.canvasNodeTexts)}`);
  if (!(out.canvasLine ?? "").includes("画布")) bad.push(`画布留痕不对：${out.canvasLine}`);
  if (out.error) bad.push("异常: " + out.error);
  if (bad.length) {
    console.error("✗ " + bad.join("；"));
    process.exitCode = 1;
  } else {
    console.log("✓ 工具协议端到端通：模型调了 memory_save，界面留痕 + 磁盘落地");
    console.log("✓ 审批闸门也真的拦住了：每步确认档下磁盘没有新增（且界面写明等你确认）");
  }
}
