import { chromium } from "playwright";
import { NO_PAGE_HINT, bootApp, freshDir, killTree, openCanvas, shot, waitForPage } from "./harness.mjs";

/**
 * 验收：**聊天里产出的文件会变成卡片**（§186）。⚠️ **这条调模型**（1 次调用）。
 *
 * ## 为什么要有这条
 *
 * §185 把工具接进聊天之后，我意识到一个相邻的问题：模型在**正文**里写的
 * `<artifact …>` 标签，聊天原来会**原样显示成标签原文**，并且文件落盘了界面上看不见
 * —— 正是 §141 打的"暗箱"。
 *
 * ## 验什么
 *
 * ① 在聊天里让它产一个 HTML 产物（提示词抄自 `accept-canvasopen.mjs`，是验证过的）
 * ② ⭐ 聊天里出现产物卡片（`wb-artcard-*`）
 * ③ ⭐ 正文里**不再有** `<artifact` 标签原文
 * ④ 卡片上带协议类型编号（`data-artifact-resource-type`，与工作台同一套）
 */
const DATA = "D:/DoubaoWorkClone/.verify/chatartifact-data";
if (!(await freshDir(DATA))) {
  console.error("✗ 数据目录 " + DATA + " 删不掉 —— 先手工关掉占着它的 Electron");
  process.exit(1);
}

const PORT = 9338;
const out = {};
let child = null;

try {
  const r = await bootApp({ port: PORT, dataDir: DATA, timeoutMs: 30000 });
  child = r.child;
  if (!r.ok) {
    console.error("[诊断] 应用输出尾部：\n" + (r.getLog() || "(空)").slice(-1200));
    await killTree(child);
    process.exit(1);
  }

  const b = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
  const page = await waitForPage(b);
  if (!page) throw new Error(NO_PAGE_HINT);
  await page.waitForSelector('[data-testid="wb"]', { timeout: 20000 });

  /* 打开画布 → 展开画布对话 */
  await openCanvas(page);
  await page.waitForTimeout(1200);
  await page.locator('[data-testid="wb-canvas-chat-toggle"]').click();
  await page.waitForTimeout(900);
  out.chatOpen = (await page.locator('[data-testid="chat-input"]').count()) > 0;

  /*
   * ⚠️ 必须真的敲键（输入框是受控的，只 fill 不改 React state，
   * 发送按钮就一直 disabled —— §185 踩过这个坑）。
   */
  await page.locator('[data-testid="chat-input"]').click();
  await page.locator('[data-testid="chat-input"]').pressSequentially(
    "用 html 输出一个单文件页面，标题是「今日待办」，带一个列表。直接给完整 HTML。",
    { delay: 10 },
  );
  await page.waitForTimeout(300);
  await page.locator('[data-testid="chat-input"]').press("Enter");

  /* 等卡片出现（最多 120 秒） */
  /*
   * ⚠️ 数卡片不能数 `[data-testid^="wb-artcard-"]` —— 那个前缀也匹配卡**内部**的
   * `wb-artcard-body-*` / `wb-artcard-open-*`（§176 记过的"裸前缀"坑，
   * 这一轮我又犯了一次：第一遍跑出来是 3，其实是 1 张卡 + 2 个内部元素）。
   * 用**只长在真卡片上**的标记：那张卡才有 `data-office-artifact-card-kind`。
   */
  let cards = 0;
  for (let i = 0; i < 60; i += 1) {
    cards = await page.locator("[data-office-artifact-card-kind]").count();
    if (cards > 0) break;
    await page.waitForTimeout(2000);
  }
  out.cards = cards;

  out.chatBody = await page.evaluate(() =>
    (document.querySelector(".chat-list")?.textContent ?? document.body.textContent ?? "")
      .replace(/\s+/g, " ")
      .slice(0, 900),
  );
  out.hasRawTag = (out.chatBody ?? "").includes("<artifact");
  out.kind = cards
    ? await page.locator("[data-office-artifact-card-kind]").first().getAttribute("data-office-artifact-card-kind")
    : "";
  out.resourceType = cards
    ? await page.locator("[data-office-artifact-card-kind]").first().getAttribute("data-artifact-resource-type")
    : "";
  out.shot = await shot(page, "chatartifact.png");

  await b.close();
} catch (e) {
  out.error = String(e).slice(0, 300);
} finally {
  console.log(JSON.stringify(out, null, 2));
  await killTree(child);

  const bad = [];
  if (out.error) bad.push("异常: " + out.error);
  if (!out.chatOpen) bad.push("画布对话没打开");
  if (out.cards !== 1) bad.push(`⭐ 聊天里应当恰好 1 张产物卡片（裸前缀会多数出内部元素）：${out.cards}`);
  if (out.cards < 1) bad.push(`⭐ 聊天里没出产物卡片（模型可能没吐 artifact 标签，看 chatBody）：${out.chatBody}`);
  if (out.hasRawTag) bad.push("⭐ 正文里还留着 `<artifact` 标签原文（应当被提成卡片）");
  if (!out.kind) bad.push("卡片上没有 `data-office-artifact-card-kind`");
  if (!out.resourceType) bad.push("卡片上没有 `data-artifact-resource-type`（与工作台同款约束）");

  if (bad.length) {
    console.error("✗ " + bad.join("；"));
    process.exitCode = 1;
  } else {
    console.log(`✓ 聊天产物卡片成立：卡片 kind=${out.kind} resourceType=${out.resourceType}，正文里没有标签原文`);
  }
}
