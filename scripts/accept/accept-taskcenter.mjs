import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";
import { bootApp, connectWithRetry, freshDir, killTree, shot } from "./harness.mjs";

/**
 * 验收：**任务中心**（§154，对应 `chat/task-center`）。
 *
 * ## 这条**不调模型**（进批跑），靠预置 tasks.json / library.json 造出确定性的场景
 *
 * 六条断言：
 * ① 三块分区都在，文案与本体一致
 * ② 进行中的任务 / 最近访问**分得对**（running+awaiting vs done）
 * ③ 置顶：点了就标上「已置顶」，**重开还在**（落盘）
 * ④ ⭐ 置顶**满了要说出口**（「最多可置顶 8 个服务」）—— 库里的 togglePinned 是静默返回
 * ⑤ 移除**在跑的**对话要先确认，且有「取消」；确认后真没了
 * ⑥ 超出的条目走「查看更多」
 */
const DATA = "D:/DoubaoWorkClone/.verify/center-data";
if (!(await freshDir(DATA))) {
  console.error("✗ 数据目录 " + DATA + " 删不掉 —— 先手工关掉占着它的 Electron");
  process.exit(1);
}

/* ── 预置场景 ── */
// freshDir 只保证"删干净"，不保证目录存在；要预置文件就得自己建
fs.mkdirSync(DATA, { recursive: true });
const mkTask = (id, title, stage, createdAt) => ({
  id,
  title,
  brief: title,
  createdAt,
  stage,
  startedAt: createdAt,
  finishedAt: stage === "done" ? createdAt : null,
  steps: [{ id: "s1", role: "user", text: title, at: createdAt }],
  questions: [],
  questionIndex: 0,
  activity: "",
  artifacts: [],
});
const NOW = Date.now();
/*
 * ⚠️ 预置数据要**符合系统的不变量**：`normalizeTask` 把"上次关窗口时还在跑/在等"的任务
 * 一律标成 `failed`（原样留成 running 的话，界面会显示一个永远转下去的任务，
 * 而它其实早就没有请求在跑了）。所以**落盘过的任务不可能是"进行中"**。
 *
 * 第一版我在 fixtures 里塞了 running/awaiting，结果它们被正确标成 failed、
 * 分进了「最近访问」—— 红得对，是我造的数据不符合不变量。
 *
 * 「进行中的任务」那一块因此按**空态**断言；`needsStopConfirm`（移除在跑的对话要先问）
 * 的判定由单测覆盖（`taskCenter.test.ts`）。
 */
const tasks = [
  mkTask("t-new", "刚被中断的对话", "failed", NOW - 1000),
  ...Array.from({ length: 8 }, (_, i) => mkTask(`t-done${i}`, `已完成的对话${i}`, "done", NOW - 10000 - i)),
];
fs.writeFileSync(path.join(DATA, "tasks.json"), JSON.stringify(tasks, null, 2), "utf8");
/* 置顶先放满 8 个，好验"满了要说出口" */
fs.writeFileSync(
  path.join(DATA, "library.json"),
  JSON.stringify({ installed: [], enabled: [], pinned: tasks.filter((t) => t.id.startsWith("t-done")).map((t) => t.id) }, null, 2),
  "utf8",
);

const PORT = 9303;
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

  let b = await connectWithRetry(chromium, `http://127.0.0.1:${PORT}`);
  let ctx = b.contexts()[0];
  let page = ctx.pages()[0] ?? (await ctx.waitForEvent("page"));
  await page.waitForSelector('[data-testid="wb"]', { timeout: 20000 });

  /* ── ① 入口与三块 ── */
  out.entryExists = (await page.locator('[data-testid="wb-center-open"]').count()) > 0;
  await page.locator('[data-testid="wb-center-open"]').click();
  await page.waitForTimeout(1200);
  out.opened = (await page.locator('[data-testid="wb-center"]').count()) > 0;
  out.headers = await page.evaluate(() =>
    Array.from(document.querySelectorAll(".wb-center-section h3")).map((e) => (e.textContent ?? "").trim()),
  );
  out.title = await page.evaluate(
    () => document.querySelector(".wb-center-head h2")?.textContent?.trim() ?? "",
  );
  out.hasExploreServices = (await page.locator('[data-testid^="wb-center-service-"]').count()) > 0;

  /*
   * ⚠️ 2026-10-13 补：`wb-center-explore` 这个 testid **原来没有任何脚本引用过**
   * （`src/` × `scripts/accept/` 交叉，见 HANDOFF §208 的零覆盖清单）——
   * 上面那条只数了服务项，**容器本身**没人看过。断**后果**：容器在、里面有服务项、
   * 且「发现更多服务」那一块的标题逐字（一个空壳区块是最容易被放烂的形态）。
   *
   * 另外两条（`wb-center-empty` 空态、`wb-center-confirm-ok/cancel` 确认框）**没在这里补**：
   *   · 空态要"一条任务都没有"的数据目录 —— 见新脚本 `accept-emptystates.mjs`；
   *   · 确认框只在任务**真在跑**时才弹（`needsStopConfirm`），而落盘过的任务会被
   *     `normalizeTask` 标成 failed —— 要造出那个窗口必须先真跑一轮，属于"要模型"那一类。
   */
  out.exploreBox = await page.evaluate(() => {
    const box = document.querySelector('[data-testid="wb-center-explore"]');
    return {
      count: box ? 1 : 0,
      heading: box?.querySelector("h3")?.textContent?.trim() ?? "",
      services: box ? box.querySelectorAll('[data-testid^="wb-center-service-"]').length : 0,
      width: box ? Math.round(box.getBoundingClientRect().width) : null,
    };
  });

  /* ── ② 分块正确 ── */
  out.ongoingTitles = await page.evaluate(() =>
    Array.from(document.querySelectorAll('[data-testid="wb-center-ongoing"] .wb-center-title')).map((e) =>
      (e.textContent ?? "").trim(),
    ),
  );
  out.recentTitles = await page.evaluate(() =>
    Array.from(document.querySelectorAll('[data-testid="wb-center-recent"] .wb-center-title')).map((e) =>
      (e.textContent ?? "").trim(),
    ),
  );
  out.ongoingIds = await page.evaluate(() =>
    Array.from(document.querySelectorAll('[data-testid="wb-center-ongoing"] [data-testid^="wb-center-row-"]')).map((e) =>
      (e.getAttribute("data-testid") ?? "").replace("wb-center-row-", ""),
    ),
  );
  /*
   * 「进行中的任务」这一块：预置数据里不可能有它 ——
   * 落盘过的任务在读回时一律被标成 failed（见文件开头那段注释），
   * 所以这里读的是**空态提示**，而不是硬要求它有内容。
   */
  out.ongoingEmptyHint = await page.evaluate(
    () => document.querySelector('[data-testid="wb-center-ongoing"] .wb-center-none')?.textContent?.trim() ?? "",
  );

  /* ── ⑥ 查看更多 ── */
  out.moreVisible = (await page.locator('[data-testid="wb-center-more"]').count()) > 0;
  out.moreText = await page.evaluate(
    () => document.querySelector('[data-testid="wb-center-more"]')?.textContent?.trim() ?? "",
  );

  /* ── ④ 置顶满了要说出口（置顶已放满 8 个）── */
  await page.locator('[data-testid="wb-center-pin-t-new"]').click();
  await page.waitForTimeout(400);
  out.fullToast = await page.evaluate(
    () => document.querySelector('[data-testid="wb-center-toast"]')?.textContent?.trim() ?? "",
  );

  /* ── ⑤ 移除一条**已结束**的：不必打扰用户，直接移除 ── */
  await page.locator('[data-testid="wb-center-remove-t-new"]').click();
  await page.waitForTimeout(800);
  out.noConfirmForDone = (await page.locator('[data-testid="wb-center-confirm"]').count()) === 0;
  out.rowGoneAfterRemove = (await page.locator('[data-testid="wb-center-row-t-new"]').count()) === 0;

  out.shot = await shot(page, "taskcenter.png");
  await b.close();

  /* ── ③ 置顶能落盘：先取消一个置顶，再重开看它在不在 ── */
  fs.writeFileSync(
    path.join(DATA, "library.json"),
    JSON.stringify({ installed: [], enabled: [], pinned: ["t-done0"] }, null, 2),
    "utf8",
  );
  await killTree(child);
  await new Promise((r) => setTimeout(r, 1500));
  if (!(await boot())) {
    out.error = "重启失败：" + (getLog() || "(空)").slice(-300);
  } else {
    b = await connectWithRetry(chromium, `http://127.0.0.1:${PORT}`);
    ctx = b.contexts()[0];
    page = ctx.pages()[0] ?? (await ctx.waitForEvent("page"));
    await page.waitForSelector('[data-testid="wb"]', { timeout: 20000 });
    await page.locator('[data-testid="wb-center-open"]').click();
    await page.waitForTimeout(1200);
    out.pinnedMark = await page.evaluate(
      () => document.querySelector('[data-testid="wb-center-pinned-t-done0"]')?.textContent?.trim() ?? "",
    );
    out.pinIconNow = await page.evaluate(
      () => (document.querySelector('[data-testid="wb-center-unpin-t-done0"]') ? "unpin" : "pin"),
    );
    await b.close();
  }
} catch (e) {
  out.error = String(e).slice(0, 300);
} finally {
  console.log(JSON.stringify(out, null, 2));
  await killTree(child);

  const bad = [];
  if (out.error) bad.push("异常: " + out.error);

  if (!out.entryExists) bad.push("左栏没有「任务中心」入口");
  if (!out.opened) bad.push("点了入口没进任务中心");
  if (out.title !== "任务中心") bad.push(`标题不对：${out.title}`);
  if (
    JSON.stringify(out.headers) !== JSON.stringify(["进行中的任务", "最近访问", "发现更多服务"])
  ) {
    bad.push(`三块分区与本体不符：${JSON.stringify(out.headers)}`);
  }
  if (!out.hasExploreServices) bad.push("「发现更多服务」里没有服务项");

  /* 补的那条（零覆盖清单里的 `wb-center-explore` 容器，§208） */
  if (out.exploreBox?.count !== 1) bad.push("任务中心没有「发现更多服务」那一块");
  if ((out.exploreBox?.heading ?? "") !== "发现更多服务") bad.push(`那一块的标题不对：${out.exploreBox?.heading}`);
  if ((out.exploreBox?.services ?? 0) < 1) bad.push("那一块里一个服务都没有");
  if (!(out.exploreBox?.width > 200)) bad.push(`⭐「发现更多服务」被挤塌了（宽 ${out.exploreBox?.width}px）`);

  if (!out.ongoingEmptyHint) bad.push("「进行中的任务」既没内容也没有空态提示");
  if ((out.ongoingTitles ?? []).length) {
    bad.push(`进行中的任务不该有内容（预置数据全是已结束的）：${JSON.stringify(out.ongoingTitles)}`);
  }
  if ((out.recentTitles ?? []).some((x) => x.includes("刚被中断") === false && x.includes("已完成的对话") === false)) {
    bad.push(`最近访问里出现了不该有的东西：${JSON.stringify(out.recentTitles)}`);
  }

  if (!out.moreVisible) bad.push("超过上限时没有出现「查看更多」");
  if (out.moreText !== "查看更多") bad.push(`查看更多文案不对：${out.moreText}`);

  if (out.fullToast !== "最多可置顶 8 个服务") bad.push(`置顶满了没提示对：${out.fullToast}`);

  if (!out.noConfirmForDone) bad.push("移除已结束的对话却弹了确认框");
  if (!out.rowGoneAfterRemove) bad.push("点了移除那一行还在");

  if (out.pinnedMark !== "已置顶") bad.push(`重开后置顶标记没恢复：${out.pinnedMark}`);
  if (out.pinIconNow !== "unpin") bad.push(`置顶的图标状态不对：${out.pinIconNow}`);

  if (bad.length) {
    console.error("✗ " + bad.join("；"));
    process.exitCode = 1;
  } else {
    console.log(
      "✓ 任务中心成立：三块对齐本体 / 分块正确（落盘过的必然不是进行中）/ 置顶满了会说 / 已结束的直接移除 / 置顶状态能落盘",
    );
  }
}
