import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";
import { NO_PAGE_HINT, bootApp, connectWithRetry, freshDir, killTree, pickPort, shot, waitForPage } from "./harness.mjs";

/**
 * 验收：**知识库桌面面板（G15）+ 工作流时间线（G10）**。
 *
 * 两条都是"界面层缺的那一块"，判据只能是真实的 DOM 与真实的库文件：
 *
 * ① 知识库：设置里点进「知识库」→ 粘贴一段 → 保存 → 搜同一个词 → 命中里有原文；
 *    并且 `<数据目录>/knowledge.db` 真的被建出来（不是只改了界面）。
 * ② 时间线：预置一份带 `startedAt/finishedAt` 的运行检查点 → 工作流页出现
 *    `wb-workflow-timeline`，两步各自有段、宽度不为 0（说明按真实时间算了比例）。
 */
const DATA = ".verify/knowledge-timeline-data";
if (!(await freshDir(DATA))) {
  console.error("✗ 数据目录 " + DATA + " 删不掉 —— 先手工关掉占着它的 Electron");
  process.exit(1);
}

/* 预置一份运行检查点（CLI 写的就是这个形状） */
const runsDir = path.join(DATA, "workflows", "runs");
fs.mkdirSync(runsDir, { recursive: true });
const base = 1_700_000_000_000;
fs.writeFileSync(
  path.join(runsDir, "run-demo.json"),
  JSON.stringify(
    {
      id: "run-demo",
      name: "演示流水线",
      status: "done",
      createdAt: base,
      updatedAt: base + 8000,
      steps: [
        { id: "research", agent: "researcher", task: "收集数据", dependsOn: [], status: "done", startedAt: base, finishedAt: base + 3000 },
        { id: "write", agent: "writer", task: "写成周报", dependsOn: ["research"], status: "done", startedAt: base + 3000, finishedAt: base + 8000 },
      ],
    },
    null,
    2,
  ),
  "utf8",
);

const out = {};
const booted = await bootApp({ port: await pickPort([9381]), dataDir: DATA, timeoutMs: 30000 });
const { child, ok, getLog } = booted;
try {
  if (!ok) throw new Error("应用没起来：" + (getLog() || "").slice(-600));
  const b = await connectWithRetry(chromium, `http://127.0.0.1:${booted.port}`);
  const page = await waitForPage(b);
  if (!page) throw new Error(NO_PAGE_HINT);
  await page.waitForSelector('[data-testid="wb"]', { timeout: 20000 });
  await page.waitForTimeout(1500);

  /* ── G15 知识库面板 ── */
  await page.locator('[data-testid="wb-account"]').click();
  await page.waitForTimeout(600);
  await page.locator('[data-testid="wb-acct-settings"]').click();
  await page.waitForTimeout(800);
  out.knowledgeRow = (await page.locator('[data-testid="wb-set-知识库"]').count()) > 0;
  await page.locator('[data-testid="wb-set-知识库"]').click();
  await page.waitForTimeout(700);
  out.panel = (await page.locator('[data-testid="wb-knowledge"]').count()) > 0;

  const TITLE = "验收资料";
  const MARK = "青竹计划在周五前完成迁移";
  await page.locator('[data-testid="wb-knowledge-title"]').fill(TITLE);
  await page.locator('[data-testid="wb-knowledge-text"]').fill(`${MARK}。负责人：阿洁。`);
  await page.locator('[data-testid="wb-knowledge-save"]').click();
  await page.waitForTimeout(900);
  out.saveNote = (await page.locator('[data-testid="wb-knowledge-note"]').textContent())?.trim() ?? "";

  await page.locator('[data-testid="wb-knowledge-query"]').fill("迁移");
  await page.locator('[data-testid="wb-knowledge-search"]').click();
  await page.waitForTimeout(800);
  out.hits = (await page.locator('[data-testid="wb-knowledge-hits"] li').count()) > 0;
  out.hitText = (await page.locator('[data-testid="wb-knowledge-hits"]').textContent())?.trim().slice(0, 200) ?? "";
  out.docs = (await page.locator('[data-testid="wb-knowledge-docs"] li').count()) > 0;
  out.dbExists = fs.existsSync(path.join(DATA, "knowledge.db"));
  out.shotKnowledge = await shot(page, "knowledge-panel.png");
  await page.locator('[data-testid="wb-settings-close"]').click();
  await page.waitForTimeout(500);

  /* ── G10 工作流时间线 ── */
  await page.locator('[data-testid="wb-nav-workflow"]').click();
  await page.waitForTimeout(900);
  out.timeline = (await page.locator('[data-testid="wb-workflow-timeline"]').count()) > 0;
  out.segments = await page.evaluate(() =>
    Array.from(document.querySelectorAll('[data-testid^="wb-workflow-timeline-"]'))
      .filter((el) => el.getAttribute("data-testid") !== "wb-workflow-timeline")
      .map((el) => {
        const box = el.getBoundingClientRect();
        return { id: el.getAttribute("data-testid"), width: Math.round(box.width), left: Math.round(box.left) };
      }),
  );
  out.shotTimeline = await shot(page, "workflow-timeline.png");
  await b.close();
} catch (e) {
  out.error = String(e).slice(0, 300);
} finally {
  await killTree(child);
  console.log(JSON.stringify(out, null, 2));
  const bad = [];
  if (!out.knowledgeRow) bad.push("设置里没有「知识库」入口");
  if (!out.panel) bad.push("点进去没有知识库面板");
  if (!out.saveNote.includes("已保存")) bad.push(`保存回执不对：${JSON.stringify(out.saveNote)}`);
  if (!out.hits) bad.push("搜「迁移」没有命中（导入没落库或检索没接）");
  if (!out.hitText.includes("青竹计划")) bad.push("命中的片段里没有原文 —— 引用不可溯源");
  if (!out.docs) bad.push("已收录列表是空的");
  if (!out.dbExists) bad.push("knowledge.db 没有建出来（只改了界面）");
  if (!out.timeline) bad.push("工作流页没有时间线");
  const segs = out.segments ?? [];
  if (segs.length !== 2) bad.push(`时间线应该有 2 段，实际 ${segs.length}`);
  if (segs.some((s) => !(s.width > 0))) bad.push(`有段的宽度为 0：${JSON.stringify(segs)}`);
  if (out.error) bad.push("异常: " + out.error);
  if (bad.length) {
    console.error("✗ " + bad.join("；"));
    process.exitCode = 1;
  } else {
    console.log("✓ 知识库面板真能导入/检索（库文件在），工作流时间线按真实起止画出两段");
  }
}
