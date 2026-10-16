import { chromium } from "playwright";
import { bootApp, connectWithRetry, finishedTurns, freshDir, killTree, shot, waitTurnEnd } from "./harness.mjs";

/**
 * 验收：**上下文压缩**（§149）。
 *
 * ## 为什么这样验
 *
 * 真造一段两万 token 的对话要十几次模型调用。所以用**验收开关**
 * （本地存储 `dsh-canvas.compact-keep-tokens`，界面上没有入口）把保留额度压到 30，
 * 三轮对话就必然触发压缩。
 *
 * ## 三条断言（各自堵一种"假成功"）
 *
 * ① 界面上出现「更早的 N 条对话已压缩为摘要」——
 *    证明**压缩真的发生了**（没发生的话下面那条可能只是"历史够短"）。
 * ② 第三轮答得出 `42` —— 42 **只出现在第一轮**，而第一轮正是被压掉的那批。
 *    答得出 = **摘要确实把关键数字带过去了**。
 *    只断言①是不够的：压缩发生了但把数字丢了，那是更糟的结果。
 * ③ **本地对话没被动过**：六个气泡（3 问 3 答）都还在。
 *    压缩只该改变"这次发给模型什么"，**不许删用户看得到的历史**。
 */
const DATA = ".verify/compaction-data";
if (!(await freshDir(DATA))) {
  console.error("✗ 数据目录 " + DATA + " 删不掉 —— 先手工关掉占着它的 Electron");
  process.exit(1);
}

/* ⚠️ 2026-10-16（审计 G06/G07）：bootApp 会换端口重试 —— 下面用的是它返回的实际端口，不再假设给哪个就用哪个 */
let PORT = 9298;
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

  /* 把保留额度压到 30 token（默认 20000）—— 只影响"什么时候压" */
  await page.evaluate(() => localStorage.setItem("dsh-canvas.compact-keep-tokens", "30"));
  await page.reload();
  await page.waitForSelector('[data-testid="wb"]', { timeout: 20000 });
  out.knob = await page.evaluate(() => localStorage.getItem("dsh-canvas.compact-keep-tokens"));

  const assistantCount = () => page.locator(".wb-assistant-text").count();
  const send = async (text, _expectCount) => {
    /*
     * ⚠️ 2026-10-16（审计 G108）：原来等的是「助手气泡 count 涨到预期值」+ 固定 sleep ——
     * 那是**半截回复**（首 token 一到就退出循环，后面那句 `waitForTimeout` 只是碰运气）。
     * 现在等的是会话记录里的 `done`：引擎自己定义的终态（见 harness 的 `waitTurnEnd`）。
     */
    const before = await finishedTurns(page);
    await page.locator('[data-testid="wb-composer-input"]').fill(text);
    await page.locator('[data-testid="wb-send"]').click();
    await waitTurnEnd(page, before, 120_000);
    // 提问卡会挡住后续发送，先答掉（正常情况下这几句不需要澄清）
    for (let i = 0; i < 3; i += 1) {
      if ((await page.locator('[data-testid="wb-question-card"]').count()) === 0) break;
      await page.locator('[data-testid="wb-option-0"]').first().click();
      await page.waitForTimeout(2500);
    }
  };

  await page.locator('[data-testid="wb-nav-home"]').click();
  await page.waitForTimeout(800);
  await send("请记住：我的幸运数字是 42。只回复「好」。", 1);
  await send("我最喜欢的颜色是蓝色。只回复「好」。", 2);
  await send("我的幸运数字是多少？只回答数字。", 3);

  out.notes = await page.evaluate(() =>
    Array.from(document.querySelectorAll(".wb-step-note")).map((e) => (e.textContent ?? "").trim()),
  );
  out.lastReply = await page.evaluate(() => {
    const all = Array.from(document.querySelectorAll(".wb-assistant-text"));
    return all.length ? (all[all.length - 1].textContent ?? "").trim() : "";
  });
  /* ③ 本地历史必须原样还在 */
  out.userBubbles = await page.locator(".wb-bubble-user").count();
  out.assistantBubbles = await assistantCount();
  out.shot = await shot(page, "compaction.png");

  await b.close();
} catch (e) {
  out.error = String(e).slice(0, 300);
} finally {
  console.log(JSON.stringify(out, null, 2));
  await killTree(child);

  const bad = [];
  if (out.error) bad.push("异常: " + out.error);

  /* ① 压缩真的发生了 */
  if (!(out.notes ?? []).length) bad.push("界面上没有出现「已压缩为摘要」—— 压缩没触发或没告知用户");
  else if (!out.notes.join("|").includes("已压缩为摘要")) bad.push("提示文案不对：" + out.notes.join("|"));

  /* ② 关键数字穿过了摘要 */
  if (!(out.lastReply ?? "").includes("42")) {
    bad.push(`第三轮答不出 42（回复：${JSON.stringify((out.lastReply ?? "").slice(0, 60))}）—— 摘要把关键信息丢了`);
  }

  /* ③ 本地历史没被压缩动过 */
  if (out.userBubbles < 3) bad.push(`本地少了用户消息（只有 ${out.userBubbles} 条）—— 压缩不许删本地历史`);
  if (out.assistantBubbles < 3) bad.push(`本地少了助手消息（只有 ${out.assistantBubbles} 条）—— 压缩不许删本地历史`);

  if (bad.length) {
    console.error("✗ " + bad.join("；"));
    process.exitCode = 1;
  } else {
    console.log("✓ 上下文压缩成立：真的压了、关键数字穿过摘要、本地历史一条没少");
  }
}
