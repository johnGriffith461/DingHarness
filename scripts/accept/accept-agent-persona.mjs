import { chromium } from "playwright";
import { bootApp, connectWithRetry, finishedTurns, freshDir, killTree, shot, waitTurnEnd } from "./harness.mjs";

/**
 * 验收：**AI 智能体的人设真的生效**（§156）。
 *
 * ## 为什么要单独一条
 *
 * `accept-agent.mjs` 验的是表单与落盘（不调模型，进批跑）。
 * 但"建了个智能体"和"它真的以那个身份说话"是两回事 ——
 * 后者只能真调一次模型才知道。
 *
 * ## 断言
 *
 * ① **一键完善**真的写出了设定描述（不是把标签原样抄回来）
 * ② ⭐ 用一个"必须在开头原样输出暗号"的智能体问一句普通问题，
 *    回复里**真的有那个暗号** —— 这是唯一能证明
 *    "智能体的设定描述进了系统提示词"的证据
 *
 * ⚠️ 原来这条会真调模型（约 1~2 分钟），所以一直待在"不进批跑"的名单里。
 *    2026-10-16 收进批跑：假通道补了「复述:X」这条装置标记（见 `verify-acceptances.mjs`
 *    的 `startLocalFakeModel`）—— **上下文里出现 `复述:X`，回复里就带上 X**。
 *    于是「暗号」写成 `复述:【喵】` 之后，人设没进系统提示词就必然答不出暗号（照旧红），
 *    进了就答得出。判据一个字没放宽，换掉的只是"谁来照做"。
 *
 * ## 变异实证（2026-10-16）
 *   把人设描述里的 `复述:【喵】` 去掉（等于"人设没进提示词"的那一侧）→ 回复里没有【喵】→
 *   这一条**当场变红**（`✗ 回复里没有 【喵】`）。
 */
const DATA = ".verify/agent-persona-data";
if (!(await freshDir(DATA))) {
  console.error("✗ 数据目录 " + DATA + " 删不掉 —— 先手工关掉占着它的 Electron");
  process.exit(1);
}

/**
 * 人设里的「暗号」。
 *
 * ⚠️ 形状是**装置标记**（`复述:X`）：假通道按它决定"回复里要不要带上这个词"。
 * 它只有真的进了系统提示词才会出现在请求里，所以「回复里有它」这句话
 * 仍然等价于「人设真的到了模型眼前」。
 */
const MARK = "复述:【喵】";

/* ⚠️ 2026-10-16（审计 G06/G07）：bootApp 会换端口重试 —— 下面用的是它返回的实际端口，不再假设给哪个就用哪个 */
let PORT = 9306;
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
  const ctx = b.contexts()[0];
  const page = ctx.pages()[0] ?? (await ctx.waitForEvent("page"));
  await page.waitForSelector('[data-testid="wb"]', { timeout: 20000 });

  await page.locator('[data-testid="wb-nav-home"]').click();
  await page.waitForTimeout(600);
  await page.locator('[data-testid="wb-composer-add"]').click();
  await page.waitForTimeout(300);
  await page.locator('[data-testid="wb-add-agent"]').click();
  await page.waitForTimeout(1000);

  /* ── ① 一键完善：只给名称与标签，让它写描述 ── */
  await page.locator('[data-testid="wb-agent-name"]').fill("猫老师");
  await page.locator('[data-testid="wb-agent-tag-characteristic-温和"]').click();
  await page.locator('[data-testid="wb-agent-tag-hobby-书籍"]').click();
  await page.locator('[data-testid="wb-agent-fill"]').click();
  const fillDeadline = Date.now() + 90000;
  let desc = "";
  while (Date.now() < fillDeadline) {
    await page.waitForTimeout(2000);
    desc = await page.locator('[data-testid="wb-agent-desc"]').inputValue();
    if (desc.trim()) break;
  }
  out.filledDescription = desc.slice(0, 80);
  out.fillNote = await page.evaluate(
    () => document.querySelector('[data-testid="wb-agent-note"]')?.textContent?.trim() ?? "",
  );

  /* ── ② 把描述换成带暗号的，建出来（创建即选中） ── */
  await page
    .locator('[data-testid="wb-agent-desc"]')
    .fill(`你是一只猫老师，说话温和。硬性要求：你每次回答的**开头**都必须原样输出 ${MARK} 这三个字符，然后再正常回答。`);
  await page.locator('[data-testid="wb-agent-start"]').click();
  await page.waitForTimeout(1200);
  out.backHome = (await page.locator('[data-testid="wb-composer"]').count()) > 0;

  /* ── 用这个智能体问一句普通问题 ── */
  await page.locator('[data-testid="wb-composer-input"]').fill("1 加 1 等于几？只回答数字。");
  /*
   * ⚠️ 等**这一轮真的结束**（会话记录里的 `done`），不要"气泡一出现就读"（审计 G108 同族）。
   * 原来这里是"读到非空就 break" —— 读到的是**首片正文**：
   * 实测拿到的是「（本地假通道第 5 轮）正在逐段返回，用来验证流式」这种半截回复，
   * 于是"暗号在没在回复里"这件事被一个**还没流完**的字符串判死（假红）。
   */
  const before = await finishedTurns(page);
  await page.locator('[data-testid="wb-send"]').click();
  await waitTurnEnd(page, before, 120_000);
  let reply = "";
  for (let i = 0; i < 10 && !reply; i += 1) {
    await page.waitForTimeout(600);
    reply = await page.evaluate(() => {
      const all = Array.from(document.querySelectorAll(".wb-assistant-text"));
      return all.length ? (all[all.length - 1].textContent ?? "").trim() : "";
    });
  }
  out.reply = reply.slice(0, 120);
  out.shot = await shot(page, "agent-persona.png");

  await b.close();
} catch (e) {
  out.error = String(e).slice(0, 300);
} finally {
  console.log(JSON.stringify(out, null, 2));
  await killTree(child);

  const bad = [];
  if (out.error) bad.push("异常: " + out.error);

  /* ① 一键完善真的写了东西，而且不是把标签抄回来 */
  if (!(out.filledDescription ?? "").trim()) {
    bad.push(`「一键完善」没写出设定描述（note：${out.fillNote}）`);
  } else if ((out.filledDescription ?? "").includes("背景：") && (out.filledDescription ?? "").includes("特征：")) {
    bad.push("「一键完善」只是把标签抄了回来，没有写成描述");
  }
  /* ② 人设真的进了系统提示词 */
  if (!(out.reply ?? "").includes(MARK)) {
    bad.push(`回复里没有 ${MARK}（回复：${JSON.stringify(out.reply)}）—— 智能体的设定没进系统提示词`);
  }

  if (bad.length) {
    console.error("✗ " + bad.join("；"));
    process.exitCode = 1;
  } else {
    console.log("✓ 智能体人设生效：一键完善写出了描述；用带暗号的智能体提问，回复真的带上了暗号");
  }
}
