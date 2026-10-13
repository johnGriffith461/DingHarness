import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";
import { NO_PAGE_HINT, bootApp, freshDir, killTree, shot, waitForPage } from "./harness.mjs";

/**
 * 验收：**子智能体上交的调用能被就地批准**（§176）+ 放行真的执行（§144 那套）。
 *
 * ## 这条**不调模型**（进批跑）
 *
 * 办法是把**那条回复当时会有的状态**种下来：一个任务、一条 assistant 步骤，
 * 步骤上挂着两条 `pending: true` 的留痕（形状就是 `blockedToTraces` 造出来的那种：
 * 有工具名、有参数、有 id）。这正是"子智能体上交"之后界面上的样子。
 *
 * 五条断言：
 * ① 两条待批准项都出现，各自有「允许 / 拒绝」按钮
 * ② ⭐ 点「允许」→ **那次调用真的执行了**（`memory.json` 里出现了那条内容）
 * ③ ⭐ 那一行**换成结果**（不是还写着"等你确认"）
 * ④ ⭐ 点「拒绝」→ **磁盘上没有留下东西**，那一行写着「你已拒绝」
 * ⑤ 拒绝的那条不许被执行（上面那一条记忆仍然只有 1 条，不是 2 条）
 */
const DATA = "D:/DoubaoWorkClone/.verify/approve-data";
if (!(await freshDir(DATA))) {
  console.error("✗ 数据目录 " + DATA + " 删不掉 —— 先手工关掉占着它的 Electron");
  process.exit(1);
}
fs.mkdirSync(DATA, { recursive: true });

const ALLOW_ID = "call-allow-1";
const DENY_ID = "call-deny-1";
const ALLOW_TEXT = "用户喜欢在周五下午开周会";
const DENY_TEXT = "用户住在某个不该被记住的地方";

fs.writeFileSync(
  path.join(DATA, "tasks.json"),
  JSON.stringify(
    [
      {
        id: "t-approve",
        title: "子智能体上交的调用",
        brief: "帮我记两件事",
        createdAt: Date.now() - 60_000,
        stage: "done",
        startedAt: Date.now() - 59_000,
        finishedAt: Date.now() - 58_000,
        steps: [
          { id: "s-0", role: "user", text: "帮我记两件事", at: Date.now() - 60_000 },
          {
            id: "s-1",
            role: "assistant",
            text: "子智能体那边有两件事想改，需要你确认。",
            at: Date.now() - 58_000,
            tools: [
              {
                toolCallId: ALLOW_ID,
                name: "memory_save",
                ok: true,
                pending: true,
                line: "⚙ 记忆：子智能体想做但没被批准（等你确认）",
                input: { text: ALLOW_TEXT },
              },
              {
                toolCallId: DENY_ID,
                name: "memory_save",
                ok: true,
                pending: true,
                line: "⚙ 记忆：子智能体想做但没被批准（等你确认）",
                input: { text: DENY_TEXT },
              },
            ],
          },
        ],
      },
    ],
    null,
    2,
  ),
  "utf8",
);

const PORT = 9328;
const out = {};
let child = null;
let ok = false;
let getLog = () => "";

const boot = async () => {
  const r = await bootApp({ port: PORT, dataDir: DATA, timeoutMs: 30000 });
  child = r.child;
  ok = r.ok;
  getLog = r.getLog;
  return ok;
};

/*
 * ⚠️ 按**留痕行自己的** testid 读，不要靠里面的按钮找 —— 放行/拒绝之后按钮就没了，
 * 那样读到的永远是空串（第一版就是这么误判的）。
 */
const traceLine = (page, id) =>
  page.evaluate((callId) => {
    const row = document.querySelector(`[data-testid="wb-tool-line-${callId}"]`);
    return row ? (row.textContent ?? "").replace(/\\s+/g, " ").trim() : "";
  }, id);

const memoryTexts = () => {
  const file = path.join(DATA, "memory.json");
  if (!fs.existsSync(file)) return [];
  try {
    return (JSON.parse(fs.readFileSync(file, "utf8"))?.entries ?? []).map((e) => e.text);
  } catch {
    return [];
  }
};

try {
  if (!(await boot())) {
    console.error("[诊断] 应用输出尾部：\n" + (getLog() || "(空)").slice(-1200));
    await killTree(child);
    process.exit(1);
  }

  const b = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
  const page = await waitForPage(b);
  if (!page) throw new Error(NO_PAGE_HINT);
  await page.waitForSelector('[data-testid="wb"]', { timeout: 20000 });

  await page.locator('[data-testid="wb-nav-home"]').click();
  await page.waitForTimeout(800);
  await page.locator('[data-testid="wb-recent-t-approve"]').click();
  await page.waitForTimeout(1500);

  /* ① 两条待批准项与按钮 */
  out.allowBtn = await page.locator(`[data-testid="wb-tool-allow-${ALLOW_ID}"]`).count();
  out.denyBtn = await page.locator(`[data-testid="wb-tool-deny-${DENY_ID}"]`).count();
  out.lineBefore = await traceLine(page, ALLOW_ID);

  /* ② 允许 */
  await page.locator(`[data-testid="wb-tool-allow-${ALLOW_ID}"]`).click();
  await page.waitForTimeout(1800);
  out.lineAfterAllow = await traceLine(page, ALLOW_ID);
  out.memAfterAllow = memoryTexts();

  /* ④⑤ 拒绝 */
  await page.locator(`[data-testid="wb-tool-deny-${DENY_ID}"]`).click();
  await page.waitForTimeout(1200);
  out.lineAfterDeny = await traceLine(page, DENY_ID);
  out.memAfterDeny = memoryTexts();

  out.shot = await shot(page, "approve.png");
  await b.close();
} catch (e) {
  out.error = String(e).slice(0, 300);
} finally {
  console.log(JSON.stringify(out, null, 2));
  await killTree(child);

  const bad = [];
  if (out.error) bad.push("异常: " + out.error);

  if (out.allowBtn !== 1) bad.push("「允许」按钮没出现");
  if (out.denyBtn !== 1) bad.push("「拒绝」按钮没出现");
  if (!(out.lineBefore ?? "").includes("等你确认")) bad.push(`待批准那条没有说清在等确认：${out.lineBefore}`);

  /* ② 允许 → 真的执行了 */
  if (!(out.memAfterAllow ?? []).includes(ALLOW_TEXT)) {
    bad.push(`⭐ 点了「允许」但那次调用没真的执行：${JSON.stringify(out.memAfterAllow)}`);
  }
  /* ③ 那一行换成结果 */
  if ((out.lineAfterAllow ?? "").includes("等你确认")) bad.push("放行之后那一行还写着等你确认");
  if (!(out.lineAfterAllow ?? "").includes("已保存")) bad.push(`放行之后那一行没换成结果：${out.lineAfterAllow}`);

  /* ④⑤ 拒绝 → 什么都没发生 */
  if ((out.memAfterDeny ?? []).includes(DENY_TEXT)) bad.push("⭐ 点了「拒绝」竟然还是执行了");
  if (!(out.lineAfterDeny ?? "").includes("你已拒绝")) bad.push(`拒绝之后那一行不对：${out.lineAfterDeny}`);
  if ((out.memAfterDeny ?? []).length !== (out.memAfterAllow ?? []).length) {
    bad.push(`拒绝前后记忆条数变了：${JSON.stringify(out.memAfterDeny)}`);
  }

  if (bad.length) {
    console.error("✗ " + bad.join("；"));
    process.exitCode = 1;
  } else {
    console.log(
      `✓ 就地批准成立：允许真的执行了（记忆里出现「${ALLOW_TEXT}」）、那一行换成结果；拒绝什么都没发生且写明「你已拒绝」`,
    );
  }
}
