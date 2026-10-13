import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";
import { bootApp, freshDir, killTree, shot } from "./harness.mjs";

/**
 * 验收：**多轮对话（在同一段对话里接着聊）**（§147）。
 *
 * ## 为什么要有这条
 *
 * 之前任务视图里的输入框提交的是 `createTask` —— 在已有对话里接着说一句，
 * 应用会**新建一个任务**，之前那几轮**完全不在上下文里**。
 * 也就是说这个应用**根本没有多轮对话**（本体的「主对话」是多轮的）。
 *
 * ⚠️ **这条会真调模型**（约 1 分钟），所以不进无模型批跑，单独跑。
 *
 * ## 断言（三条缺一不可）
 *
 * ① `after === before + 1` —— 新回复是**追加在同一段对话里**的。
 *    如果又新建了任务，视图会跳到那个新任务上、里面只有 1 条助手消息，这条立刻红。
 * ② 左栏「最近」的行数不变 —— 没有多出一段对话。
 * ③ **最后那条回复里有 `6`** —— 这是唯一能证明"历史真送到了"的证据：
 *    `那再乘以 3 呢？` 里的"那"指代上一轮的 `1 + 1 = 2`，
 *    **没有历史的话模型根本不知道要拿什么乘 3**。
 */
const DATA = "D:/DoubaoWorkClone/.verify/followup-data";
if (!(await freshDir(DATA))) {
  console.error("✗ 数据目录 " + DATA + " 删不掉 —— 先手工关掉占着它的 Electron");
  process.exit(1);
}

const PORT = 9297;
const { child, ok, getLog } = await bootApp({ port: PORT, dataDir: DATA, timeoutMs: 30000 });
if (!ok) {
  console.error("[诊断] 应用输出尾部：\n" + (getLog() || "(空)").slice(-1200));
  await killTree(child);
  process.exit(1);
}

const out = {};
try {
  const b = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
  const ctx = b.contexts()[0];
  const page = ctx.pages()[0] ?? (await ctx.waitForEvent("page"));
  await page.waitForSelector('[data-testid="wb"]', { timeout: 20000 });

  const assistantCount = () => page.locator(".wb-assistant-text").count();
  const lastAssistant = () =>
    page.evaluate(() => {
      const all = Array.from(document.querySelectorAll(".wb-assistant-text"));
      return all.length ? (all[all.length - 1].textContent ?? "").trim() : "";
    });
  const recentCount = () => page.locator('[data-testid^="wb-recent-"]').count();

  /** 有提问卡就先答掉（第一句是纯提问，正常不该出现；出现了也不能让它卡住这一轮）。 */
  const clearQuestions = async () => {
    for (let i = 0; i < 3; i += 1) {
      if ((await page.locator('[data-testid="wb-question-card"]').count()) === 0) return;
      await page.locator('[data-testid="wb-option-0"]').first().click();
      await page.waitForTimeout(2500);
    }
  };

  /* ── 第一轮：新开一段对话，并且**真的调一次工具** ── */
  await page.locator('[data-testid="wb-nav-home"]').click();
  await page.waitForTimeout(800);
  await page
    .locator('[data-testid="wb-composer-input"]')
    .fill("请调用 memory_save 工具记住：我的幸运数字是 42。然后只回复「好」这一个字。");
  await page.locator('[data-testid="wb-send"]').click();

  const firstDeadline = Date.now() + 90000;
  while (Date.now() < firstDeadline && (await assistantCount()) === 0) {
    await page.waitForTimeout(1500);
  }
  await clearQuestions();
  out.firstReply = await lastAssistant();
  out.firstToolLine = await page.evaluate(() => {
    const lines = Array.from(document.querySelectorAll(".wb-tool-line")).map((e) => e.textContent?.trim() ?? "");
    return lines[0] ?? null;
  });
  out.memoryOnDisk = fs.existsSync(path.join(DATA, "memory.json"))
    ? fs.readFileSync(path.join(DATA, "memory.json"), "utf8")
    : "";
  out.afterFirst = await assistantCount();
  out.recentBefore = await recentCount();
  await shot(page, "followup-1.png");

  /* ── 第二轮：**不换页、不新建**，就在这段对话里接着说 ── */
  await page.locator('[data-testid="wb-composer-input"]').fill("我的幸运数字是多少？只回答数字。");
  await page.locator('[data-testid="wb-send"]').click();

  const secondDeadline = Date.now() + 90000;
  while (Date.now() < secondDeadline && (await assistantCount()) <= out.afterFirst) {
    await page.waitForTimeout(1500);
  }
  await clearQuestions();
  out.secondReply = await lastAssistant();
  out.afterSecond = await assistantCount();
  out.recentAfter = await recentCount();

  /* 用户那两句是不是都在同一段对话里（用户气泡 = 2 个） */
  out.userTexts = await page.evaluate(() =>
    Array.from(document.querySelectorAll(".wb-bubble-user")).map((e) => (e.textContent ?? "").trim().slice(0, 30)),
  );
  out.shot = await shot(page, "followup-2.png");

  await b.close();
} catch (e) {
  out.error = String(e).slice(0, 300);
} finally {
  console.log(JSON.stringify(out, null, 2));
  await killTree(child);

  const bad = [];
  if (out.error) bad.push("异常: " + out.error);

  /*
   * ① 追加在同一段对话里。
   * 若"又新建了任务"，视图会跳到新任务上、里面只有 1 条助手消息 —— 这条立刻红。
   */
  if (!(out.afterSecond === out.afterFirst + 1)) {
    bad.push(`第二轮没有追加在同一段对话里（助手消息 ${out.afterFirst} → ${out.afterSecond}）`);
  }
  /* ② 没有多出一段对话 */
  if (out.recentAfter !== out.recentBefore) {
    bad.push(`左栏多出了对话（最近 ${out.recentBefore} → ${out.recentAfter}）—— 说明又新建了任务`);
  }
  /* ③ 历史真送到了：不含 42 就说明模型没看到上一轮 */
  if (!(out.secondReply ?? "").includes("42")) {
    bad.push(`第二轮答不出 42（回复：${JSON.stringify((out.secondReply ?? "").slice(0, 60))}）—— 历史没送到模型`);
  }
  /* 第一轮的工具真的执行了、历史里也带着它的留痕（§148 的组合路径） */
  if (!out.firstToolLine) bad.push("第一轮没有工具留痕 —— 这一轮就没压到「历史带工具」的路径");
  if (!(out.memoryOnDisk ?? "").includes("42")) bad.push("memory.json 里没有 42 —— 第一轮的工具没真的写盘");
  /* 用户那两句应当都在这段对话里 */
  if ((out.userTexts ?? []).length < 2) bad.push(`这段对话里只看到 ${(out.userTexts ?? []).length} 条用户消息`);

  if (bad.length) {
    console.error("✗ " + bad.join("；"));
    process.exitCode = 1;
  } else {
    console.log("✓ 多轮对话成立：第二轮追加在同一段对话里（没新建任务），且模型答得出只在上一轮出现过的 42");
  }
}
