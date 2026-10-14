import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";
import { NO_PAGE_HINT, bootApp, connectWithRetry, freshDir, killTree, openCanvas, shot, verdict, waitForPage } from "./harness.mjs";

/**
 * 验收：**两条对话路径看到的东西一样**（C2-4 的落点）。
 *
 * ⚠️ **这条会真调模型**（2 次）—— 一次工作台、一次聊天。
 *
 * ## 为什么这条必须有
 *
 * 装配（"这一轮给模型的 system 由哪几块拼成"）原来写在两条路各自的代码里，实测后果是：
 * **同一个模型、同一个用户，在工作台问得出长期记忆里的东西，在聊天里问不出**。
 * 工具描述里还写着"以后每次对话都会自动带上"—— 而聊天侧压根没带。文案与事实相反。
 *
 * 所以验收必须**两边各问一次同样的问题**，且问题只能靠"注入的记忆"答对：
 * 记忆里放一个暗号，问它暗号是什么。没注入就答不出来（这是可证伪的地方）。
 */
const DATA = ".verify/bothpaths-data";
if (!(await freshDir(DATA))) {
  console.error("✗ 数据目录 " + DATA + " 删不掉 —— 先手工关掉占着它的 Electron");
  process.exit(1);
}
fs.mkdirSync(DATA, { recursive: true });

/** 只有注入才可能被模型知道的暗号（形状按 `MemoryEntry`）。 */
const CODE_WORD = "紫色犀牛";
fs.writeFileSync(
  path.join(DATA, "memory.json"),
  JSON.stringify(
    {
      entries: [
        { id: "m1", text: `用户的口令是「${CODE_WORD}」`, createdAt: new Date().toISOString(), source: "manual" },
      ],
    },
    null,
    2,
  ),
  "utf8",
);

const PORT = 9314;
const QUESTION = "我的口令是什么？只回答口令本身，不要解释。";
const out = {};
let child = null;
let b = null;

const lastAssistant = (page) =>
  page.evaluate(() => {
    const all = Array.from(document.querySelectorAll(".wb-assistant-text"));
    return all.length ? (all[all.length - 1].textContent ?? "").trim() : "";
  });

/** 聊天侧的最新一条助手消息（类名是 `chat-msg assistant`，见 ChatSidebar）。 */
const lastChatReply = (page) =>
  page.evaluate(() => {
    const all = Array.from(document.querySelectorAll(".chat-msg.assistant"));
    return all.length ? (all[all.length - 1].textContent ?? "").trim() : "";
  });

try {
  const r = await bootApp({ port: PORT, dataDir: DATA, timeoutMs: 30000 });
  child = r.child;
  if (!r.ok) throw new Error(`调试端口 ${PORT} 没开：\n` + (r.getLog() || "(空)").slice(-800));
  b = await connectWithRetry(chromium, `http://127.0.0.1:${PORT}`);
  const page = await waitForPage(b);
  if (!page) throw new Error(NO_PAGE_HINT);
  await page.waitForSelector('[data-testid="wb"]', { timeout: 20000 });
  await page.waitForTimeout(1200);

  /* ── ① 工作台：首页问一次 ── */
  await page.locator('[data-testid="wb-nav-home"]').click();
  await page.waitForTimeout(500);
  await page.locator('[data-testid="wb-composer-input"]').fill(QUESTION);
  await page.locator('[data-testid="wb-send"]').click();
  const deadline = Date.now() + 120000;
  while (Date.now() < deadline && (await page.locator(".wb-assistant-text").count()) === 0) {
    await page.waitForTimeout(1500);
  }
  // 有提问卡就先答掉（正常不该出现，出现了也不能卡住）
  for (let i = 0; i < 3; i += 1) {
    if ((await page.locator('[data-testid="wb-question-card"]').count()) === 0) break;
    await page.locator('[data-testid="wb-option-0"]').first().click();
    await page.waitForTimeout(2500);
  }
  await page.waitForTimeout(2500);
  out.workbenchReply = await lastAssistant(page);
  out.workbenchKnows = out.workbenchReply.includes(CODE_WORD);
  out.shotWorkbench = await shot(page, "bothpaths-workbench.png");

  /* ── ② 聊天侧栏问一次（同一个问题） ── */
  await openCanvas(page);
  await page.waitForTimeout(1200);
  await page.locator('[data-testid="wb-canvas-chat-toggle"]').click();
  await page.waitForTimeout(1000);
  if ((await page.locator('[data-testid="chat-input"]').count()) === 0) {
    throw new Error("画布对话没打开（`wb-canvas-chat-toggle`）");
  }
  await page.locator('[data-testid="chat-input"]').click();
  await page.locator('[data-testid="chat-input"]').pressSequentially(QUESTION, { delay: 12 });
  await page.waitForTimeout(300);
  await page.locator('[data-testid="chat-input"]').press("Enter");
  const chatDeadline = Date.now() + 120000;
  let chatReply = "";
  while (Date.now() < chatDeadline) {
    chatReply = await lastChatReply(page);
    if (chatReply.includes(CODE_WORD) || chatReply.length > 40) break;
    await page.waitForTimeout(2000);
  }
  await page.waitForTimeout(1500);
  out.chatReply = await lastChatReply(page);
  out.chatKnows = out.chatReply.includes(CODE_WORD);
  out.shotChat = await shot(page, "bothpaths-chat.png");

  await b.close();
} catch (e) {
  out.error = String(e).slice(0, 300);
} finally {
  console.log(JSON.stringify(out, null, 2));
  await killTree(child);
}

const bad = [];
if (out.error) bad.push("异常: " + out.error);
if (!out.workbenchKnows) bad.push(`工作台答不出口令（注入这侧坏了）：${(out.workbenchReply ?? "").slice(0, 60)}`);
if (!out.chatKnows) bad.push(`⭐ 聊天侧答不出口令（C2-4 没生效）：${(out.chatReply ?? "").slice(0, 60)}`);
verdict(bad, "两条路看到的一样：同一个口令，工作台与聊天都答得出来");
