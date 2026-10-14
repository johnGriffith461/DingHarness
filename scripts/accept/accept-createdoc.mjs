import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";
import { NO_PAGE_HINT, bootApp, connectWithRetry, freshDir, killTree, readStoreFile, shot, waitForPage } from "./harness.mjs";

/**
 * 验收：**「创建文档」——把对话里的一条消息变成一篇文档**（§172）。
 *
 * ## 这条**不调模型**（进批跑）
 *
 * 办法是**种一条对话记录**（`tasks.json` 里放一个任务 + 一条 assistant 消息），
 * 这样界面上就真有一条可以"创建文档"的消息 —— 不需要模型跑一轮。
 *
 * 六条断言：
 * ① 消息动作里有「创建文档」（逐字）
 * ② ⭐ 点它之后**跳到了文档面板**，且那篇文档的正文就是消息原文（一字不差）
 * ③ 标题取第一行（不是一整段）
 * ④ ⭐ 建好之后那句话是证据里那句：已为你创建文档。你想如何调整这篇文档？请随时告诉我。
 * ⑤ 文档真的落盘了（`docs.json` 里查得到，不是只在界面上）
 * ⑥ 留痕写着「从对话创建」
 */
const DATA = "D:/DoubaoWorkClone/.verify/createdoc-data";
if (!(await freshDir(DATA))) {
  console.error("✗ 数据目录 " + DATA + " 删不掉 —— 先手工关掉占着它的 Electron");
  process.exit(1);
}
fs.mkdirSync(DATA, { recursive: true });

/*
 * ⚠️ 用**真换行**（模板字符串），不要写成 `\n` 字面量 ——
 * 第一版写成 `\\n`，于是消息里是反斜杠加 n 两个字符、没有换行，
 * 标题就取不出"第一行"（那条断言因此红了）。
 */
const MSG = `季度复盘的三条结论
1. 上传链路补齐
2. 面板能看了
3. 边界也补了`;
const STEP_ID = "s-seed-1";

fs.writeFileSync(
  path.join(DATA, "tasks.json"),
  JSON.stringify(
    [
      {
        id: "t-seed",
        title: "季度复盘",
        brief: "帮我看一下季度复盘",
        createdAt: Date.now() - 60_000,
        stage: "done",
        startedAt: Date.now() - 59_000,
        finishedAt: Date.now() - 58_000,
        steps: [
          { id: "s-seed-0", role: "user", text: "帮我看一下季度复盘", at: Date.now() - 60_000 },
          { id: STEP_ID, role: "assistant", text: MSG, at: Date.now() - 58_000 },
        ],
      },
    ],
    null,
    2,
  ),
  "utf8",
);

const PORT = 9324;
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

try {
  if (!(await boot())) {
    console.error("[诊断] 应用输出尾部：\n" + (getLog() || "(空)").slice(-1200));
    await killTree(child);
    process.exit(1);
  }

  const b = await connectWithRetry(chromium, `http://127.0.0.1:${PORT}`);
  const page = await waitForPage(b);
  if (!page) throw new Error(NO_PAGE_HINT);
  await page.waitForSelector('[data-testid="wb"]', { timeout: 20000 });

  /* 打开那条种下来的对话 */
  await page.locator('[data-testid="wb-nav-home"]').click();
  await page.waitForTimeout(800);
  const opened = await page.evaluate(() => {
    const row = document.querySelector('[data-testid="wb-recent-t-seed"]');
    if (!row) {
      // 找不到就把页面上有什么打出来 —— 省得下一次继续猜
      return {
        why: "没有 wb-recent-t-seed",
        seen: Array.from(document.querySelectorAll("[data-testid]"))
          .map((e) => e.getAttribute("data-testid"))
          .filter((x) => x.includes("recent") || x.includes("task") || x.includes("nav"))
          .slice(0, 20),
      };
    }
    row.click();
    return { ok: true };
  });
  out.opened = opened;
  out.openedTask = Boolean(opened && opened.ok);
  await page.waitForTimeout(1200);

  /* ① 按钮在不在 */
  out.hasButton = (await page.locator(`[data-testid="wb-act-createdoc-${STEP_ID}"]`).count()) > 0;
  out.buttonTitle = await page.evaluate(
    (id) => document.querySelector(`[data-testid="wb-act-createdoc-${id}"]`)?.getAttribute("title") ?? "",
    STEP_ID,
  );

  /* ② 点它 */
  if (out.hasButton) {
    await page.locator(`[data-testid="wb-act-createdoc-${STEP_ID}"]`).click();
    await page.waitForTimeout(1500);
  }

  out.onDocPanel = (await page.locator('[data-testid="wb-doc-body"]').count()) > 0;
  out.body = out.onDocPanel ? await page.locator('[data-testid="wb-doc-body"]').inputValue() : "";
  out.title = await page.evaluate(() => {
    const el = document.querySelector('[data-testid="wb-doc-title"]');
    return el ? el.value : "";
  });
  out.note = await page.evaluate(
    () => document.querySelector('[data-testid="wb-doc-note"]')?.textContent?.trim() ?? "",
  );

  /* ⑤⑥ 落盘与留痕 */
  await page.waitForTimeout(900);
  const file = path.join(DATA, "docs.json");
  out.docsOnDisk = fs.existsSync(file) ? readStoreFile(file) : null;
  out.shot = await shot(page, "createdoc.png");

  await b.close();
} catch (e) {
  out.error = String(e).slice(0, 300);
} finally {
  console.log(JSON.stringify(out, null, 2));
  await killTree(child);

  const bad = [];
  if (out.error) bad.push("异常: " + out.error);

  if (!out.openedTask) bad.push("没打开种下来的那条对话");
  if (!out.hasButton) bad.push("消息动作里没有「创建文档」");
  if (out.buttonTitle !== "创建文档") bad.push(`按钮标题不是逐字的「创建文档」：${out.buttonTitle}`);

  if (!out.onDocPanel) bad.push("点了「创建文档」之后没有跳到文档面板");
  /* ② 正文一字不差（用真实换行比） */
  const wantBody = MSG;
  if (out.body !== wantBody) bad.push(`文档正文与消息不一致：${JSON.stringify(out.body)}`);
  /* ③ 标题取第一行 */
  if (out.title !== "季度复盘的三条结论") bad.push(`标题取错了：${out.title}`);
  /* ④ 那句话 */
  if (out.note !== "已为你创建文档。你想如何调整这篇文档？请随时告诉我。") {
    bad.push(`建好之后那句话不对：${out.note}`);
  }

  /* ⑤⑥ 落盘 */
  const docs = out.docsOnDisk;
  const list = Array.isArray(docs) ? docs : (docs?.docs ?? []);
  if (!Array.isArray(list) || list.length === 0) bad.push(`文档没落盘：${JSON.stringify(docs)?.slice(0, 120)}`);
  else {
    const mine = list.find((d) => (d.body ?? "").includes("上传链路补齐"));
    if (!mine) bad.push("落盘的文档里找不到刚创建的那篇");
    if (mine && !(mine.versions ?? []).some((v) => v.reason === "从对话创建")) {
      bad.push(`留痕里没有「从对话创建」：${JSON.stringify((mine.versions ?? []).map((v) => v.reason))}`);
    }
  }

  if (bad.length) {
    console.error("✗ " + bad.join("；"));
    process.exitCode = 1;
  } else {
    console.log("✓ 创建文档成立：动作逐字 / 跳文档面板 / 正文一字不差 / 标题取第一行 / 那句话逐字 / 落盘且留痕");
  }
}
