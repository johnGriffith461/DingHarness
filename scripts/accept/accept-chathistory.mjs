import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";
import { NO_PAGE_HINT, bootApp, connectWithRetry, freshDir, killTree, openCanvas, readStoreFile, shot, verdict, waitForPage } from "./harness.mjs";

/**
 * 验收：**聊天历史活过重启**（F3）+ **谁批的能查证**（C2 / INV-3）。
 *
 * ⚠️ **这条会真调模型**（1 次调用，逼模型调一次 `memory_save`），所以不进无模型批跑。
 *
 * ## 为什么这条必须有
 *
 * 聊天以前**完全不落盘**（消息只在内存里，重启即空）。C2 之后主进程会写
 * **会话事件日志**（`sessions/chat-<对话 id>.jsonl`），F3 让界面**从日志恢复**。
 * 这条验收要走完那条真实链路，而且必须**真重启**（不是刷新）——
 * 刷新只证明"内存里还在"，那正是以前也成立、却毫无价值的那个结论。
 *
 * ## 断言（缺一不可）
 *
 * ① 说一句 → 模型调工具 → 被闸门拦下，出现**可点的「允许」**。
 * ② ⭐ **重启之后**：历史还在（用户那句 + 回复），而且那条「允许」**仍然可点**
 *    —— 这是"重启后 pending 留痕消失、用户永远批不了"那个老病的反证。
 * ③ 点「允许」→ 工具真的执行（`memory.json` 里有那句话）。
 * ④ ⭐⭐ **再重启一次**：那一行变成**结论**（「已保存」），而且**不再有按钮**
 *    —— 决策记录进了日志（INV-3），恢复时按它回到"批过之后"的样子。
 */
const DATA = ".verify/chathistory-data";
if (!(await freshDir(DATA))) {
  console.error("✗ 数据目录 " + DATA + " 删不掉 —— 先手工关掉占着它的 Electron");
  process.exit(1);
}

const PORT = 9336;
const MEMO_KEY = "用户喜欢在周五下午开周会";
const out = { restarts: 0 };
let child = null;
let b = null;

const readMemory = () => {
  const f = path.join(DATA, "memory.json");
  if (!fs.existsSync(f)) return null;
  try {
    return (readStoreFile(f)?.entries ?? []).map((e) => e.text);
  } catch {
    return null;
  }
};

/** 起一个实例并打开画布对话。 */
async function openChat() {
  const r = await bootApp({ port: PORT, dataDir: DATA, timeoutMs: 30000 });
  child = r.child;
  if (!r.ok) throw new Error(`调试端口 ${PORT} 没开：\n` + (r.getLog() || "(空)").slice(-800));
  b = await connectWithRetry(chromium, `http://127.0.0.1:${PORT}`);
  const page = await waitForPage(b);
  if (!page) throw new Error(NO_PAGE_HINT);
  await page.waitForSelector('[data-testid="wb"]', { timeout: 20000 });
  await page.waitForTimeout(1200);
  await openCanvas(page);
  await page.waitForTimeout(1200);
  await page.locator('[data-testid="wb-canvas-chat-toggle"]').click();
  await page.waitForTimeout(1000);
  return page;
}

/** 关掉当前实例（**整个应用重启**，不是刷新）。 */
async function restart() {
  out.restarts += 1;
  await b?.close().catch(() => undefined);
  await killTree(child);
  await new Promise((r) => setTimeout(r, 2500));
}

/** 全页文本（找"历史还在不在"用；聊天消息没有统一的 testid）。 */
const bodyText = (page) =>
  page.evaluate(() => (document.body.textContent ?? "").replace(/\s+/g, " "));

/** 当前可点的「允许」的 id（没有就空串）。 */
const allowId = (page) =>
  page.evaluate(() => {
    const el = document.querySelector('[data-testid^="chat-tool-allow-"]');
    return el ? (el.getAttribute("data-testid") ?? "").replace("chat-tool-allow-", "") : "";
  });

try {
  /* ── 第一段：说一句，逼模型调工具，被拦下 ── */
  let page = await openChat();

  // 档位设成「按需确认」：写类工具会被拦下（与 accept-chatapprove 同一套）
  await page.locator('[data-testid="wb-nav-home"]').click();
  await page.waitForTimeout(400);
  await page.locator('[data-testid="wb-confirm"]').click();
  await page.waitForTimeout(500);
  const low = page.locator('[data-testid="wb-confirm-option-按需确认"]');
  if ((await low.count()) > 0) await low.click();
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);

  await page.locator('[data-testid="chat-input"]').click();
  await page.locator('[data-testid="chat-input"]').pressSequentially(`记住：${MEMO_KEY}`, { delay: 12 });
  await page.waitForTimeout(300);
  await page.locator('[data-testid="chat-input"]').press("Enter");

  let id = "";
  for (let i = 0; i < 45; i += 1) {
    id = await allowId(page);
    if (id) break;
    await page.waitForTimeout(2000);
  }
  out.firstAllowId = id;
  out.shot1 = await shot(page, "chathistory-1.png");

  /* ── 第二段：整应用重启 → 历史与待批准都该在 ── */
  if (id) {
    await restart();
    page = await openChat();
    await page.waitForTimeout(1500);
    out.afterRestartText = (await bodyText(page)).slice(0, 600);
    out.afterRestartHasUser = out.afterRestartText.includes(MEMO_KEY);
    out.afterRestartAllowId = await allowId(page);
    out.afterRestartAllowCount = await page.locator('[data-testid^="chat-tool-allow-"]').count();
    out.shot2 = await shot(page, "chathistory-2.png");
  }

  /* ── 第三段：点「允许」→ 真的执行 ── */
  if (out.afterRestartAllowId) {
    out.memBefore = readMemory();
    await page.locator(`[data-testid="chat-tool-allow-${out.afterRestartAllowId}"]`).click();
    await page.waitForTimeout(3500);
    out.memAfter = readMemory();
    out.lineAfterAllow = await page.evaluate((v) => {
      const row = document.querySelector(`[data-testid="wb-tool-line-${v}"]`);
      return row ? (row.textContent ?? "").trim() : null;
    }, out.afterRestartAllowId);
  }

  /* ── 第四段：再重启 → 结论仍在、按钮不再出现 ── */
  if (out.memAfter?.length) {
    await restart();
    page = await openChat();
    await page.waitForTimeout(1500);
    out.finalText = (await bodyText(page)).slice(0, 600);
    out.finalAllowCount = await page.locator('[data-testid^="chat-tool-allow-"]').count();
    out.finalHasSaved = out.finalText.includes("已保存");
    out.shot3 = await shot(page, "chathistory-3.png");
  }

  await b?.close().catch(() => undefined);
} catch (e) {
  out.error = String(e).slice(0, 400);
} finally {
  console.log(JSON.stringify(out, null, 2));
  await killTree(child);
}

const bad = [];
if (out.error) bad.push("异常: " + out.error);
if (!out.firstAllowId) bad.push("第一段没等到可点的「允许」（模型没调工具？档位没设上？）");
if (out.restarts < 2) bad.push("没跑完两次重启（后面依赖前面，前一步红了就停在这）");
if (out.afterRestartAllowId && !out.afterRestartHasUser) bad.push("⭐ 重启后历史没回来（F3 没作用）");
if (out.afterRestartAllowId === "") bad.push("⭐ 重启后那条「允许」不见了（待批准留痕没活过来）");
if (out.afterRestartAllowCount > 1) bad.push(`重启后出现了多个「允许」：${out.afterRestartAllowCount}`);
// ⚠️ 记忆文本是模型整理的措辞（可能带句号），所以比的是"包含"而不是整个数组的全等
if (out.memAfter && !out.memAfter.some((t) => String(t).includes(MEMO_KEY))) bad.push("点了允许但记忆没写进去");
if (out.finalAllowCount !== undefined && out.finalAllowCount !== 0) bad.push(`⭐ 再重启后不该再有按钮，实际 ${out.finalAllowCount} 个（决策没进日志？）`);
if (out.finalHasSaved === false) bad.push("⭐ 再重启后那一行不是结论（「已保存」没恢复出来）");
verdict(bad, "聊天历史与决策都活过重启：历史回得来 / 待批准仍可点 / 批过之后按钮不再出现");
