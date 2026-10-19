import { chromium } from "playwright";
import path from "node:path";
import { bootApp, connectWithRetry, freshDir, killTree, readStoreFile, shot, expandComposerMore } from "./harness.mjs";

/**
 * 验收：**AI 文档**（§153）—— 对应本体 `chat/new-doc` / `chat/write`。
 *
 * ## 这条**不调模型**（操作条那步单独一条脚本），所以它进批跑
 *
 * 五条断言：
 * ① 从输入区的 `+` 能新建文档并进面板（入口是真的）
 * ② 文案与本体一致（`添加标题` / `记录你的想法` / `缩写`…）—— 证据在 `docs/evidence-aidoc.txt`  ⚠️（该依据未入库、本机也找不到 —— 无法复核；判据以本文件里的断言为准）
 * ③ 编辑后落到磁盘，**重开应用还在**（磁盘是权威，不是内存）
 * ④ 复制全文真把正文写进剪贴板
 * ⑤ 历史记录里有版本，点「回到此版本」正文真的回去了
 */
const DATA = ".verify/doc-data";
if (!(await freshDir(DATA))) {
  console.error("✗ 数据目录 " + DATA + " 删不掉 —— 先手工关掉占着它的 Electron");
  process.exit(1);
}

/* ⚠️ 2026-10-16（审计 G06/G07）：bootApp 会换端口重试 —— 下面用的是它返回的实际端口，不再假设给哪个就用哪个 */
let PORT = 9301;
const out = {};
let child = null;
let ok = false;
let getLog = () => "";

const boot = async () => {
  const r = await bootApp({ port: PORT, dataDir: DATA, timeoutMs: 30000 });
  /* 用实际端口（bootApp 换过端口时它与首选不同） */
  PORT = r.port;
  child = r.child;
  ok = r.ok;
  getLog = r.getLog;
  return ok;
};

const readDocs = () => {
  const f = path.join(DATA, "docs.json");
  try {
    return readStoreFile(f);
  } catch {
    return null;
  }
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

  /* ── ① 入口：输入区的 + → 新建文档 ── */
  await page.locator('[data-testid="wb-nav-home"]').click();
  await page.waitForTimeout(600);
  await expandComposerMore(page);
  await page.locator('[data-testid="wb-composer-add"]').click();
  await page.waitForTimeout(300);
  out.addPopOpened = (await page.locator('[data-testid="wb-add-pop"]').count()) > 0;
  out.addMenuText = await page.evaluate(
    () => document.querySelector('[data-testid="wb-add-pop"]')?.textContent?.trim() ?? "",
  );
  await page.locator('[data-testid="wb-add-doc"]').click();
  await page.waitForTimeout(1200);
  out.panelOpened = (await page.locator('[data-testid="wb-doc"]').count()) > 0;

  /* ── ② 文案与本体一致 ── */
  /*
   * ⚠️ 2026-10-13 补：`wb-doc-list` / `wb-doc-new` / `wb-doc-export` / `wb-doc-delete`
   * 这几个 testid **原来没有任何脚本引用过**（`src/` × `scripts/accept/` 交叉，
   * 见 HANDOFF §208 的零覆盖清单）—— 正是"没人点过 ⇒ 烂了也没人知道"的那一类（§201）。
   * 断**后果**：列表在且真有行、三颗按钮在且**没被禁用**、title 说的就是它该干的事。
   * ⚠️ **不点「导出文件」**：它走 `workbench.saveArtifact`（会弹系统保存框，把脚本挂住）。
   */
  out.docListCount = await page.locator('[data-testid="wb-doc-list"]').count();
  out.docItemCount = await page.locator('[data-testid^="wb-doc-item-"]').count();
  out.docHeadBtns = await page.evaluate(() =>
    ["wb-doc-new", "wb-doc-export", "wb-doc-delete"].map((id) => {
      const e = document.querySelector(`[data-testid="${id}"]`);
      return e
        ? { id, title: e.getAttribute("title") ?? "", disabled: e.hasAttribute("disabled") }
        : { id, missing: true };
    }),
  );
  out.titlePlaceholder = await page.evaluate(
    () => document.querySelector('[data-testid="wb-doc-title"]')?.getAttribute("placeholder") ?? "",
  );
  out.bodyPlaceholder = await page.evaluate(
    () => document.querySelector('[data-testid="wb-doc-body"]')?.getAttribute("placeholder") ?? "",
  );
  out.status = await page.evaluate(
    () => document.querySelector('[data-testid="wb-doc-status"]')?.textContent?.trim() ?? "",
  );
  out.actions = await page.evaluate(() =>
    Array.from(document.querySelectorAll('[data-testid^="wb-doc-act-"]')).map((e) => (e.textContent ?? "").trim()),
  );

  /* ── ③ 编辑并落盘 ── */
  await page.locator('[data-testid="wb-doc-title"]').fill("周报草稿");
  await page.locator('[data-testid="wb-doc-body"]').fill("第一段：本周做了三件事。\n第二段：下周计划两件事。");
  await page.waitForTimeout(1500); // 等延迟落盘
  const onDisk = readDocs();
  out.diskDocs = Array.isArray(onDisk) ? onDisk.length : -1;
  out.diskTitle = onDisk?.[0]?.title ?? "";
  out.diskBodyHead = (onDisk?.[0]?.body ?? "").slice(0, 12);
  out.diskVersions = onDisk?.[0]?.versions?.length ?? 0;

  /* ── ④ 复制全文 ── */
  await page.evaluate(() => navigator.clipboard.writeText("__before__"));
  await page.locator('[data-testid="wb-doc-copy"]').click();
  await page.waitForTimeout(500);
  out.clipboard = await page.evaluate(() => navigator.clipboard.readText());
  out.copyNote = await page.evaluate(
    () => document.querySelector('[data-testid="wb-doc-note"]')?.textContent?.trim() ?? "",
  );

  /*
   * ── ④b 「插入附件」在**云盘是空的时候**要如实说（2026-10-13 补）──
   *
   * `wb-doc-attach-empty` 原来没有脚本引用过。这条数据目录里没有任何云盘文件，
   * 所以点开「插入附件」应当看到空态 —— 断的是**文案逐字**（空面板最容易被做成一堆空白）。
   * 看完再点一次收起弹层，免得它挡住后面的操作。
   */
  await page.locator('[data-testid="wb-doc-attach"]').click();
  await page.waitForTimeout(600);
  out.attachEmptyText = await page.evaluate(
    () => document.querySelector('[data-testid="wb-doc-attach-empty"]')?.textContent?.trim() ?? "",
  );
  await page.locator('[data-testid="wb-doc-attach"]').click();
  await page.waitForTimeout(300);

  /* ── ⑤ 历史记录 + 回到此版本 ── */
  out.historyHiddenFirst = (await page.locator('[data-testid="wb-doc-history"]').count()) === 0;
  await page.locator('[data-testid="wb-doc-history-btn"]').click();
  await page.waitForTimeout(400);
  out.versionRows = await page.locator(".wb-doc-version").count();
  /* 先改成别的内容（产生一个新版本），再回到**有正文的那一版**。
     ⚠️ 不能点"最后一颗按钮"：版本是倒序渲染的，最后一颗对应 v0 ——
        而 v0 是刚建文档时的**空正文**。第一版就栽在这里（红得对，但那是我脚本的错）。 */
  await page.locator('[data-testid="wb-doc-body"]').fill("已被改写的内容");
  await page.waitForTimeout(1200);
  out.versionLabels = await page.evaluate(() =>
    Array.from(document.querySelectorAll(".wb-doc-version-name")).map((e) => (e.textContent ?? "").trim()),
  );
  await page.locator('[data-testid="wb-doc-restore-2"]').click();
  await page.waitForTimeout(800);
  out.bodyAfterRestore = await page.locator('[data-testid="wb-doc-body"]').inputValue();
  out.restoreNote = await page.evaluate(
    () => document.querySelector('[data-testid="wb-doc-note"]')?.textContent?.trim() ?? "",
  );
  out.shot = await shot(page, "doc.png");
  await b.close();

  /* ── ③b 重启：磁盘是权威 ── */
  await killTree(child);
  await new Promise((r) => setTimeout(r, 1500));
  if (!(await boot())) {
    out.error = "重启失败：" + (getLog() || "(空)").slice(-300);
  } else {
    b = await connectWithRetry(chromium, `http://127.0.0.1:${PORT}`);
    ctx = b.contexts()[0];
    page = ctx.pages()[0] ?? (await ctx.waitForEvent("page"));
    await page.waitForSelector('[data-testid="wb"]', { timeout: 20000 });
    /* 重启后回到紧凑首页：+ 菜单在「更多」后面 */
    await expandComposerMore(page);
    await page.locator('[data-testid="wb-composer-add"]').click();
    await page.waitForTimeout(300);
    await page.locator('[data-testid="wb-add-doc"]').click();
    await page.waitForTimeout(1200);
    out.afterRestartItems = await page.locator('[data-testid^="wb-doc-item-"]').count();
    out.afterRestartLabels = await page.evaluate(() =>
      Array.from(document.querySelectorAll('[data-testid^="wb-doc-item-"]')).map((e) => (e.textContent ?? "").trim()),
    );
    // 点开「周报草稿」那一篇
    const target = page.locator('[data-testid^="wb-doc-item-"]', { hasText: "周报草稿" }).first();
    if (await target.count()) {
      await target.click();
      await page.waitForTimeout(800);
    }
    out.afterRestartTitle = await page.locator('[data-testid="wb-doc-title"]').inputValue();
    out.afterRestartBody = await page.locator('[data-testid="wb-doc-body"]').inputValue();

    /*
     * ── ⑤b 删除 → 真的回到空态，空态那颗按钮也真能开工（2026-10-13 补）──
     *
     * `wb-doc-delete` / `wb-doc-empty` / `wb-doc-create` 三个 testid 原来都没被点过（§208）。
     * `remove()` 把当前这篇删掉后 `activeId` 变 null → 渲染的是**空态**那一支，
     * 所以这一下同时断了三件事：
     *   ① 删除真的生效（列表里那篇没了）；
     *   ② 空态出来且文案逐字（不是一片空白）；
     *   ③ 空态里的「新建文档」是**真能点**的（点下去又开出一篇来）——
     *      「看起来能点、点了没反应」是最坏的一种（手册那条"杜绝假按钮"）。
     */
    await page.locator('[data-testid="wb-doc-delete"]').click();
    await page.waitForTimeout(900);
    out.emptyShown = (await page.locator('[data-testid="wb-doc-empty"]').count()) === 1;
    out.emptyText = await page.evaluate(
      () => document.querySelector('[data-testid="wb-doc-empty"]')?.textContent?.replace(/\s+/g, "") ?? "",
    );
    out.deletedGone = (await page.locator('[data-testid^="wb-doc-item-"]', { hasText: "周报草稿" }).count()) === 0;
    out.createBtnText = await page.evaluate(
      () => document.querySelector('[data-testid="wb-doc-create"]')?.textContent?.trim() ?? "",
    );
    await page.locator('[data-testid="wb-doc-create"]').click();
    await page.waitForTimeout(1200);
    out.reopenedBody = await page.locator('[data-testid="wb-doc-body"]').count();

    await b.close();
  }
} catch (e) {
  out.error = String(e).slice(0, 300);
} finally {
  console.log(JSON.stringify(out, null, 2));
  await killTree(child);

  const bad = [];
  if (out.error) bad.push("异常: " + out.error);

  if (!out.addPopOpened) bad.push("输入区的 + 没弹出菜单");
  if (!(out.addMenuText ?? "").includes("新建文档")) bad.push(`+ 菜单里没有「新建文档」：${out.addMenuText}`);
  if (!out.panelOpened) bad.push("点了「新建文档」没有进文档面板");

  if (out.titlePlaceholder !== "添加标题") bad.push(`标题占位与本体不符：${out.titlePlaceholder}`);
  if (out.bodyPlaceholder !== "记录你的想法") bad.push(`正文占位与本体不符：${out.bodyPlaceholder}`);
  if (!(out.status ?? "").includes("已保存")) bad.push(`状态不对：${out.status}`);

  /* 补的那组（零覆盖清单里的列表与三颗顶部按钮，§208） */
  if (out.docListCount !== 1) bad.push("左侧没有「文档」列表");
  if ((out.docItemCount ?? 0) < 1) bad.push("列表里一条文档都没有（当前这篇应当也在列表里）");
  const wantHead = { "wb-doc-new": "新建文档", "wb-doc-export": "导出文件", "wb-doc-delete": "删除" };
  for (const [id, title] of Object.entries(wantHead)) {
    const row = (out.docHeadBtns ?? []).find((b) => b.id === id);
    if (!row || row.missing) bad.push(`顶部少了这颗按钮：${id}`);
    else {
      if (row.disabled) bad.push(`⭐ ${id} 被禁用了（点了没反应的假按钮）`);
      if (row.title !== title) bad.push(`${id} 的 title 应当是「${title}」，实际「${row.title}」`);
    }
  }
  if (out.attachEmptyText !== "云盘里还没有文件") {
    bad.push(`云盘为空时「插入附件」的空态文案不对：${JSON.stringify(out.attachEmptyText)}`);
  }
  if (!out.emptyShown) bad.push("删掉当前文档后没有回到空态");
  /*
   * ⚠️ 注意这里比的是**实际文案**（"开启你的第一篇AI文档" —— 正文里 AI 前后**没有空格**），
   * 而且容器 textContent 会把旁边的「新建文档」按钮一起拼进来。
   * 第一版按"逐字全等"断（还带着空格），于是读到 `开启你的第一篇AI文档新建文档` 就红 ——
   * **是断言选错了元素/口径，不是产品坏了**。这里用 includes + 实际文案。
   */
  if (!(out.emptyText ?? "").includes("开启你的第一篇AI文档")) {
    bad.push(`空态文案不对：${JSON.stringify(out.emptyText)}`);
  }
  if (!out.deletedGone) bad.push("删掉的文档还在列表里");
  if (!(out.createBtnText ?? "").includes("新建文档")) bad.push(`空态里那颗按钮文案不对：${out.createBtnText}`);
  if (!out.reopenedBody) bad.push("⭐ 空态里的「新建文档」点了没开出新文档（假按钮）");
  if (JSON.stringify(out.actions) !== JSON.stringify(["缩写", "扩写", "润色", "总结概括"])) {
    bad.push(`操作条与本体不符：${JSON.stringify(out.actions)}`);
  }

  if (out.diskDocs !== 1) bad.push(`磁盘上文档数不对：${out.diskDocs}`);
  if (out.diskTitle !== "周报草稿") bad.push(`磁盘上的标题不对：${out.diskTitle}`);
  if (!(out.diskBodyHead ?? "").includes("第一段")) bad.push(`磁盘上的正文没落进去：${out.diskBodyHead}`);

  if (!(out.clipboard ?? "").includes("第一段")) bad.push(`复制全文没把正文写进剪贴板：${out.clipboard}`);
  if (!(out.copyNote ?? "").includes("已复制全文")) bad.push(`没给复制提示：${out.copyNote}`);

  if (!out.historyHiddenFirst) bad.push("历史记录一开始就该是收起的");
  if ((out.versionRows ?? 0) < 3) bad.push(`历史版本条数太少（编辑两次至少 3 版）：${out.versionRows}`);
  if (!(out.bodyAfterRestore ?? "").includes("第一段")) {
    bad.push(`回到此版本没有还原正文：${JSON.stringify((out.bodyAfterRestore ?? "").slice(0, 40))}`);
  }

  if (!(out.afterRestartTitle ?? "").includes("周报草稿")) {
    bad.push(`重开之后文档没恢复（标题是 ${out.afterRestartTitle}，列表 ${JSON.stringify(out.afterRestartLabels)}）`);
  }
  if (!(out.afterRestartBody ?? "").includes("第一段")) {
    bad.push(`重开之后正文没恢复：${JSON.stringify((out.afterRestartBody ?? "").slice(0, 40))}`);
  }

  if (bad.length) {
    console.error("✗ " + bad.join("；"));
    process.exitCode = 1;
  } else {
    console.log("✓ AI 文档成立：入口 / 文案对齐本体 / 落盘并可重启恢复 / 复制全文 / 历史还原");
  }
}
