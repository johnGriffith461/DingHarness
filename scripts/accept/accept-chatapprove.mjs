import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";
import { NO_PAGE_HINT, bootApp, connectWithRetry, freshDir, killTree, openCanvas, readStoreFile, shot, waitForPage } from "./harness.mjs";

/**
 * 验收：**聊天里被闸门拦下的工具也能就地批准**（§185）。⚠️ **这条调模型**（1 次调用）。
 *
 * ## 为什么不进批跑
 *
 * 整条链路的起点是"模型真的调了那个工具"，没有模型就造不出来。
 *
 * ## 这条验的是这一轮真正修的那个病
 *
 * 我先把"聊天里能就地批准"写好了，**然后才去查聊天到底给不给模型工具** ——
 * 结果是**不给**（工作台传了 `useTools: true`，聊天没传）。
 * 也就是说当时的代码是**死代码**（`pending` 永远不可能出现）。
 *
 * 所以这条验收必须**从模型那头开始**：
 * ① 档位设成"低"（记忆类工具会被拦）
 * ② 在聊天里说"记住：用户喜欢在周五下午开周会" → 模型调 `memory_save` → 被拦下
 * ③ ⭐ 聊天里出现**可点的「允许」**（不是干等着）
 * ④ 点允许 → 工具真的执行 → `memory.json` 里出现那句话
 */
const DATA = "D:/DoubaoWorkClone/.verify/chatapprove-data";
if (!(await freshDir(DATA))) {
  console.error("✗ 数据目录 " + DATA + " 删不掉 —— 先手工关掉占着它的 Electron");
  process.exit(1);
}

const PORT = 9337;
const out = {};
let child = null;

const readMemory = () => {
  const f = path.join(DATA, "memory.json");
  if (!fs.existsSync(f)) return null;
  try {
    return (readStoreFile(f)?.entries ?? []).map((e) => e.text);
  } catch {
    return null;
  }
};

try {
  const r = await bootApp({ port: PORT, dataDir: DATA, timeoutMs: 30000 });
  child = r.child;
  if (!r.ok) {
    console.error("[诊断] 应用输出尾部：\n" + (r.getLog() || "(空)").slice(-1200));
    await killTree(child);
    process.exit(1);
  }

  const b = await connectWithRetry(chromium, `http://127.0.0.1:${PORT}`);
  const page = await waitForPage(b);
  if (!page) throw new Error(NO_PAGE_HINT);
  await page.waitForSelector('[data-testid="wb"]', { timeout: 20000 });

  /* ① 档位设成"低"（记忆类工具会被拦）
   *
   * ⚠️ 真实的 testid 是 `wb-confirm`（chip）+ 弹层里的 `wb-confirm-option-<档>`。
   * 我原来猜成 `wb-confirm-low` —— 又是猜的（这一轮第 3 次）。
   */
  await page.locator('[data-testid="wb-nav-home"]').click();
  await page.waitForTimeout(400);
  await page.locator('[data-testid="wb-confirm"]').click();
  await page.waitForTimeout(500);
  /* 真实档位名：全部允许 / 按需确认 / 每步确认 —— 「按需确认」会拦下要写东西的工具 */
  const lowOption = page.locator('[data-testid="wb-confirm-option-按需确认"]');
  out.lowOptionCount = await lowOption.count();
  if (out.lowOptionCount > 0) {
    await lowOption.click();
    await page.waitForTimeout(500);
    out.modeSet = "按需确认";
  } else {
    out.modeOptions = await page.evaluate(() =>
      Array.from(document.querySelectorAll('[data-testid^="wb-confirm-option-"]')).map((e) =>
        e.getAttribute("data-testid"),
      ),
    );
  }
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);

  /* 打开画布 → 展开画布对话 */
  await openCanvas(page);
  await page.waitForTimeout(1200);
  await page.locator('[data-testid="wb-canvas-chat-toggle"]').click();
  await page.waitForTimeout(900);
  out.chatOpen = (await page.locator('[data-testid="chat-input"]').count()) > 0;

  /* ② 说一句话，逼模型调 memory_save */
  /*
   * ⚠️ 必须**真的敲键**：输入框是受控的，而发送按钮写着
   * `disabled={!draft.trim()}` —— 只 fill 不改 React 的 state，
   * 按钮就一直是禁用的（刚才就是这么超时的）。
   */
  await page.locator('[data-testid="chat-input"]').click();
  await page.locator('[data-testid="chat-input"]').pressSequentially("记住：用户喜欢在周五下午开周会", { delay: 12 });
  await page.waitForTimeout(300);
  await page.locator('[data-testid="chat-input"]').press("Enter");

  /* ③ 等那条可点的「允许」（最多 90 秒） */
  let allowId = "";
  for (let i = 0; i < 45; i += 1) {
    allowId = await page.evaluate(() => {
      const el = document.querySelector('[data-testid^="chat-tool-allow-"]');
      return el ? (el.getAttribute("data-testid") ?? "").replace("chat-tool-allow-", "") : "";
    });
    if (allowId) break;
    await page.waitForTimeout(2000);
  }
  out.allowId = allowId;
  out.allowCount = await page.locator('[data-testid^="chat-tool-allow-"]').count();
  out.chatText = await page.evaluate(() => (document.body.textContent ?? "").replace(/\s+/g, " ").slice(0, 700));
  out.shot = await shot(page, "chatapprove.png");

  if (allowId) {
    const before = readMemory();
    out.memBefore = before;
    await page.locator(`[data-testid="chat-tool-allow-${allowId}"]`).click();
    await page.waitForTimeout(3000);
    out.memAfter = readMemory();
    out.lineAfter = await page.evaluate((id) => {
      const row = document.querySelector(`[data-testid="wb-tool-line-${id}"]`);
      return row ? (row.textContent ?? "").trim() : "";
    }, allowId);
  }

  await b.close();
} catch (e) {
  out.error = String(e).slice(0, 300);
} finally {
  console.log(JSON.stringify(out, null, 2));
  await killTree(child);

  const bad = [];
  if (out.error) bad.push("异常: " + out.error);
  if (!out.chatOpen) bad.push("画布对话没打开（`wb-canvas-chat-toggle`）");
  if (out.allowCount !== 1) bad.push(`⭐ 聊天里应当恰好出现 1 个可点的「允许」：${out.allowCount}`);
  const texts = (out.memAfter ?? []).map((t) => String(t));
  if (!texts.some((t) => t.includes("周五下午开周会"))) {
    bad.push(`⭐ 点了允许之后记忆没写进去：${JSON.stringify(out.memAfter)}`);
  }

  if (bad.length) {
    console.error("✗ " + bad.join("；"));
    process.exitCode = 1;
  } else {
    console.log("✓ 聊天就地批准成立：模型调的工具被拦下 → 聊天里给出「允许」→ 点了真的执行（记忆写进去了）");
  }
}
