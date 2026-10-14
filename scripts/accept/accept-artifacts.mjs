import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";
import { NO_PAGE_HINT, bootApp, connectWithRetry, freshDir, killTree, openSummary, shot, waitForPage } from "./harness.mjs";

/**
 * 验收：**坏掉的产物 / 澄清卡不许把这段对话带崩**（§179）。
 *
 * ## 这条**不调模型**（进批跑）
 *
 * 修的是一个**真崩溃**：界面上澄清卡是 `question.options.map(...)`，
 * 落盘的 `options` 丢了或不是数组时，**那一整段对话直接打不开**。
 *
 * 种一条任务，里面放：
 * - 一个**正常**产物 + 一张**正常**澄清卡（都该显示）
 * - 一个 `kind` 不认识的产物（该被丢掉）
 * - 一张**没有选项**的澄清卡（该被丢掉 —— 一张没有选项的选择卡是死路）
 * - 一张选项全是空文案的澄清卡（该被丢掉）
 *
 * 断言：**页面照常打开**、好的照常显示、坏的没出现、控制台没有报错。
 */
const DATA = "D:/DoubaoWorkClone/.verify/artifacts-data";
if (!(await freshDir(DATA))) {
  console.error("✗ 数据目录 " + DATA + " 删不掉 —— 先手工关掉占着它的 Electron");
  process.exit(1);
}
fs.mkdirSync(DATA, { recursive: true });

fs.writeFileSync(
  path.join(DATA, "tasks.json"),
  JSON.stringify(
    [
      {
        id: "t-art",
        title: "产物与澄清卡",
        brief: "看看能不能打开",
        createdAt: Date.now() - 60_000,
        /* ⚠️ 澄清卡只在 `awaiting` 时渲染（§179 顺带修好了它能在重启后活下来） */
        stage: "awaiting",
        startedAt: Date.now() - 59_000,
        finishedAt: null,
        questionIndex: 0,
        steps: [
          { id: "s-0", role: "user", text: "看看能不能打开", at: Date.now() - 60_000 },
          {
            id: "s-1",
            role: "assistant",
            text: "这里有个产物。",
            at: Date.now() - 58_000,
            tools: [],
          },
        ],
        questions: [
          /* 正常的一张 */
          {
            id: "q-good",
            text: "这份复盘写给谁看？",
            options: [
              { label: "老板", hint: "结论优先" },
              { label: "同事", hint: "细节多一点" },
            ],
          },
          /* ⚠️ 没有 options —— 这就是原来会让整段对话打不开的那种 */
          { id: "q-nooptions", text: "这张卡没有选项" },
          /* ⚠️ 选项全是空文案 */
          { id: "q-emptyoptions", text: "选项都是空的", options: [{ hint: "只有说明" }] },
        ],
        artifacts: [
          /* 正常的产物 */
          {
            id: "a-good",
            taskId: "t-art",
            stepId: "s-1",
            title: "季度复盘",
            kind: "markdown",
            createdAt: Date.now() - 58_000,
            status: "generated",
            content: "# 季度复盘\n\n三件事。",
          },
          /* ⚠️ kind 不认识 */
          { id: "a-badkind", taskId: "t-art", title: "认不出来", kind: "word", createdAt: Date.now() - 58_000 },
          /* ⚠️ 缺 id */
          { taskId: "t-art", title: "没有 id", kind: "markdown", createdAt: Date.now() - 58_000 },
        ],
      },
    ],
    null,
    2,
  ),
  "utf8",
);

const PORT = 9331;
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

  /** 渲染期的报错要收下来 —— "没崩"不等于"没报错"。 */
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e).slice(0, 200)));

  await page.locator('[data-testid="wb-nav-home"]').click();
  await page.waitForTimeout(700);
  await page.locator('[data-testid="wb-recent-t-art"]').click();
  await page.waitForTimeout(1800);

  /* 页面还活着吗 */
  out.taskOpened = (await page.locator('[data-testid="wb"]').count()) > 0;
  out.stepText = await page.evaluate(
    () => document.querySelector(".wb-assistant-text")?.textContent?.trim() ?? "",
  );

  /* 澄清卡 */
  out.questionCards = await page.locator('[data-testid="wb-question-card"]').count();
  out.questionText = await page.evaluate(
    () => document.querySelector(".wb-question-text")?.textContent?.trim() ?? "",
  );
  out.options = await page.evaluate(() =>
    Array.from(document.querySelectorAll('[data-testid^="wb-option-"]')).map((e) => (e.textContent ?? "").trim()),
  );

  /* 产物卡 */
  out.goodArt = await page.locator('[data-testid="wb-artcard-a-good"]').count();
  out.badKindArt = await page.locator('[data-testid="wb-artcard-a-badkind"]').count();
  /*
   * ⚠️ 按**卡片本身**数，别按前缀扫 —— 卡内还有 `wb-artcard-body-*` / `wb-artcard-open-*`
   * 这些子元素（§178 就是这么把按钮当成任务行的）。
   */
  out.artCards = await page.evaluate(() =>
    Array.from(document.querySelectorAll('[data-testid^="wb-artcard-"]'))
      .map((e) => e.getAttribute("data-testid") ?? "")
      .filter((x) => !x.includes("-body-") && !x.includes("-open-"))
      .map((x) => x.replace("wb-artcard-", "")),
  );

  /* 右栏 2026-10-14 起默认收起（照原型）→ 先展开，下面读的 `wb-summary-*` 才在 */
  out.summaryOpened = await openSummary(page);
  await page.waitForTimeout(600);

  /*
   * ── 右侧「对话摘要」面板（2026-10-13 补）──
   *
   * ⚠️ `wb-summary-tabs` / `wb-summary-desc` / `wb-artifacts` / `wb-artifact-*` /
   * `wb-artifact-reveal-*` / `wb-artifact-note` / `wb-media-empty` 这一组
   * **原来没有任何脚本引用过**（`src/` × `scripts/accept/` 交叉，见 HANDOFF §208 的零覆盖清单）。
   * 右侧面板正是"没人点过"的重灾区（同类事故：技能面板被挤成 59px，§201）。
   *
   * 断的是**后果**：
   *   · 页签容器在且四个页签齐（少一个筛选就残了）；
   *   · 那行说明逐字（`仅支持查看最近 50 条消息的产物`）；
   *   · 产物容器在、里面有**这张卡**、每张卡都有「在文件夹里定位」；
   *   · ⭐ **点这张还没落盘的卡** → 面板要说「这个产物还没落盘」（不假装打开）；
   *   · 切到「图片与视频」→ 没有图片时给**空态文案**（不是一片空白）。
   * ⚠️ **不点「在文件夹里定位」**：那会真去拉起资源管理器（污染这台机器）。
   */
  out.summaryTabs = await page.evaluate(() => {
    const box = document.querySelector('[data-testid="wb-summary-tabs"]');
    return {
      count: box ? 1 : 0,
      labels: box ? Array.from(box.querySelectorAll("button")).map((b) => (b.textContent ?? "").trim()) : [],
    };
  });
  out.summaryDesc = await page.evaluate(
    () => document.querySelector('[data-testid="wb-summary-desc"]')?.textContent?.trim() ?? "",
  );
  out.summaryArtifacts = await page.evaluate(() => {
    const box = document.querySelector('[data-testid="wb-artifacts"]');
    return {
      count: box ? 1 : 0,
      cards: box
        ? box.querySelectorAll('[data-testid^="wb-artifact-"]:not([data-testid^="wb-artifact-reveal-"])').length
        : 0,
      reveals: box ? box.querySelectorAll('[data-testid^="wb-artifact-reveal-"]').length : 0,
    };
  });
  /* 点这张**没有 filePath** 的产物卡：面板应当如实说"还没落盘"，而不是假装打开了 */
  await page.locator('[data-testid="wb-artifact-a-good"] .wb-artifact-main').click();
  await page.waitForTimeout(600);
  out.artifactNote = await page.evaluate(
    () => document.querySelector('[data-testid="wb-artifact-note"]')?.textContent?.trim() ?? "",
  );
  /* 切到「图片与视频」：这个数据目录里没有任何图片 → 空态文案（看完切回产物页签） */
  await page.locator('[data-testid="wb-summary-tab-media"]').click();
  await page.waitForTimeout(1500);
  out.mediaEmpty = await page.evaluate(
    () => document.querySelector('[data-testid="wb-media-empty"]')?.textContent?.trim() ?? "",
  );
  await page.locator('[data-testid="wb-summary-tab-artifacts"]').click();
  await page.waitForTimeout(500);

  out.errors = errors;
  out.shot = await shot(page, "artifacts.png");

  await b.close();
} catch (e) {
  out.error = String(e).slice(0, 300);
} finally {
  console.log(JSON.stringify(out, null, 2));
  await killTree(child);

  const bad = [];
  if (out.error) bad.push("异常: " + out.error);

  /* ⭐ 核心：这段对话还打得开 */
  if (!out.taskOpened) bad.push("⭐ 这段对话打不开了（坏数据把渲染带崩了）");
  if (out.stepText !== "这里有个产物。") bad.push(`正文没渲染出来：${JSON.stringify(out.stepText)}`);

  /* 好的照常 */
  if (out.questionCards !== 1) bad.push(`应只有 1 张澄清卡（好的那张），实际 ${out.questionCards}`);
  if (out.questionText !== "这份复盘写给谁看？") bad.push(`澄清卡文案不对：${out.questionText}`);
  /*
   * ⚠️ 选项按钮上有**序号徽标**（`1老板` / `2同事`），所以只断言"含这些文案"，
   * 不逐字符相等 —— 序号是界面自己的事，不该因为多了个数字就判失败。
   */
  const optionsText = (out.options ?? []).join(" | ");
  for (const want of ["老板", "结论优先", "同事", "细节多一点"]) {
    if (!optionsText.includes(want)) bad.push(`选项里没有「${want}」：${optionsText}`);
  }
  if ((out.options ?? []).length !== 2) bad.push(`选项数量不对：${JSON.stringify(out.options)}`);
  if (out.goodArt !== 1) bad.push("正常产物卡没显示");

  /* 坏的没出现 */
  if (out.badKindArt !== 0) bad.push("⭐ kind 不认识的产物卡竟然渲染了");
  if (JSON.stringify(out.artCards) !== JSON.stringify(["a-good"])) {
    bad.push(`产物卡应只有 a-good 一张，实际 ${JSON.stringify(out.artCards)}`);
  }

  /* 没报错 */
  if ((out.errors ?? []).length > 0) bad.push(`渲染期有报错：${JSON.stringify(out.errors)}`);

  /* 补的那组：右侧「对话摘要」面板（零覆盖清单，§208） */
  if (out.summaryTabs?.count !== 1) bad.push("右侧没有「对话摘要」的页签容器");
  const wantTabs = ["产物", "浏览器", "图片与视频", "子智能体"];
  for (const t of wantTabs) {
    if (!(out.summaryTabs?.labels ?? []).includes(t)) {
      bad.push(`摘要面板缺「${t}」页签：${JSON.stringify(out.summaryTabs?.labels)}`);
    }
  }
  if (out.summaryDesc !== "仅支持查看最近 50 条消息的产物") {
    bad.push(`摘要面板那行说明不对：${out.summaryDesc}`);
  }
  if (out.summaryArtifacts?.count !== 1) bad.push("摘要面板没有产物容器");
  if (out.summaryArtifacts?.cards !== 1) bad.push(`产物容器里应当只有 1 张卡：${out.summaryArtifacts?.cards}`);
  if (out.summaryArtifacts?.reveals !== 1) bad.push(`每张卡都该有「在文件夹里定位」：${out.summaryArtifacts?.reveals}`);
  if (out.artifactNote !== "这个产物还没落盘") {
    bad.push(`点没落盘的产物卡，面板该说「这个产物还没落盘」，实际：${JSON.stringify(out.artifactNote)}`);
  }
  if (!(out.mediaEmpty ?? "").includes("还没有图片或视频")) {
    bad.push(`没有图片时的空态文案不对：${JSON.stringify(out.mediaEmpty)}`);
  }

  if (bad.length) {
    console.error("✗ " + bad.join("；"));
    process.exitCode = 1;
  } else {
    console.log("✓ 坏数据不崩成立：对话照常打开 / 好的产物与澄清卡都在 / 坏的被丢 / 渲染期无报错");
  }
}
