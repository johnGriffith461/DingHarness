import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";
import { bootApp, connectWithRetry, freshDir, killTree, shot } from "./harness.mjs";

/**
 * 验收：「管理历史对话」页（本体路由 `chat/thread/list`）。
 *
 * ⚠️ 这一页**没有 swagger / 接口可依** —— 依据是本体实机截图
 * （`app-triage/dynamic-ui/shot-route-thread-list.png`）：按时间分档、每行「标题 + 摘要」+ 行内 ⋯。  ⚠️（该依据未入库、本机也找不到 —— 无法复核；判据以本文件里的断言为准）
 * 所以这条验收断言的就是**截图里看得到的那些形态**，外加"行内操作真的生效"。
 *
 * 用**预置 tasks.json**造记录，不调模型 —— 时间分档不该依赖一次三十秒的模型调用。
 */
const DATA = ".verify/threads-data";
if (!(await freshDir(DATA))) {
  console.error("✗ 数据目录 " + DATA + " 删不掉 —— 先手工关掉占着它的 Electron");
  process.exit(1);
}
fs.mkdirSync(DATA, { recursive: true });

const dayAt = (daysAgo, hour = 10) => {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  d.setHours(hour, 0, 0, 0);
  return d.getTime();
};

/** 造一条任务（字段照 `task.ts` 的 WorkTask）。 */
const mk = (id, title, createdAt, text) => ({
  id,
  title,
  brief: text,
  createdAt,
  stage: "done",
  startedAt: createdAt,
  finishedAt: createdAt + 1000,
  activity: "",
  questions: [],
  questionIndex: 0,
  artifacts: [],
  steps: text ? [{ id: `${id}-s1`, role: "user", text, at: createdAt }] : [],
});

fs.writeFileSync(
  path.join(DATA, "tasks.json"),
  JSON.stringify(
    [
      mk("t-today", "今天的对话", dayAt(0, 9), "今天这件事帮我理一下"),
      mk("t-yest", "昨天的对话", dayAt(1, 15), "昨天那份材料的要点"),
      mk("t-7d", "七天内", dayAt(4, 11), "近七天里的那条记录"),
      mk("t-30d", "一月内", dayAt(20, 11), "上个月的一点东西"),
      mk("t-year", "一年内", dayAt(200, 11), "大半年前那次"),
      mk("t-old", "更早", dayAt(500, 11), "很久以前的一次"),
      mk("t-empty", "空会话", dayAt(0, 8), ""),
    ],
    null,
    2,
  ),
  "utf8",
);

/* ⚠️ 2026-10-16（审计 G06/G07）：bootApp 会换端口重试 —— 下面用的是它返回的实际端口，不再假设给哪个就用哪个 */
let PORT = 9290;
const booted = await bootApp({ port: PORT, dataDir: DATA, timeoutMs: 30000 });
const { child, ok, getLog } = booted;
/* 用实际端口（bootApp 换过端口时它与首选不同） */
PORT = booted.port;
if (!ok) {
  console.error("[诊断] 应用输出尾部：\n" + (getLog() || "(空)").slice(-1200));
  await killTree(child);
  process.exit(1);
}

const out = {};
try {
  const b = await connectWithRetry(chromium, `http://127.0.0.1:${PORT}`);
  const page = b.contexts()[0].pages().find((p) => !p.url().startsWith("devtools://"));
  await page.waitForSelector('[data-testid="wb"]', { timeout: 20000 });
  await page.waitForTimeout(2000);

  // 从「最近」那一栏的入口进去
  await page.locator('[data-testid="wb-threads-open"]').click();
  await page.waitForTimeout(800);
  out.pageOpen = (await page.locator('[data-testid="wb-threads"]').count()) === 1;

  // 分档顺序（本体截图里是 新 → 旧）
  out.groups = await page.$$eval('[data-testid="wb-threads-group"] .wb-threads-label', (els) =>
    els.map((e) => e.textContent?.trim() ?? ""),
  );

  // 每条记录落在哪一档
  out.rows = await page.evaluate(() =>
    Array.from(document.querySelectorAll('[data-testid="wb-threads-group"]')).map((g) => ({
      label: g.querySelector(".wb-threads-label")?.textContent?.trim(),
      titles: Array.from(g.querySelectorAll(".wb-threads-row-title")).map((t) => t.textContent?.trim()),
      sums: Array.from(g.querySelectorAll(".wb-threads-sum")).map((t) => t.textContent?.trim()),
    })),
  );

  // 空会话的摘要兜底（本体截图里那几行是「打开对话」）
  out.emptySummary = await page.evaluate(
    () => document.querySelector('[data-testid="wb-thread-t-empty"] .wb-threads-sum')?.textContent?.trim() ?? null,
  );

  // 行内 ⋯ 真的能开，且菜单项对
  await page.locator('[data-testid="wb-threads-menu-t-yest"]').click({ force: true });
  await page.waitForTimeout(500);
  out.menuItems = await page.$$eval('[data-testid="wb-menu"] button', (els) => els.map((e) => e.textContent?.trim() ?? ""));

  // 重命名 → 刷新后还在（这条是最容易"看着能用、重启就没了"的地方）
  await page.locator('[data-testid="wb-menu"] button', { hasText: "重命名" }).first().click();
  await page.waitForTimeout(400);
  const input = page.locator('[data-testid="wb-threads-rename-t-yest"]');
  await input.fill("改过名字的对话");
  await input.press("Enter");
  await page.waitForTimeout(1500);

  await page.reload();
  await page.waitForSelector('[data-testid="wb"]', { timeout: 20000 });
  await page.waitForTimeout(2200);
  await page.locator('[data-testid="wb-threads-open"]').click();
  await page.waitForTimeout(800);
  out.renamedAfterReload = await page.evaluate(
    () => document.querySelector('[data-testid="wb-thread-t-yest"] .wb-threads-row-title')?.textContent?.trim() ?? null,
  );

  /*
   * ── 置顶（2026-10-13 补）──
   *
   * ⚠️ `wb-thread-pinned-*`、`wb-threads-new`、`wb-threads-more`、`wb-threads-empty`
   * 这几个 testid **原来没有任何脚本引用过**（`src/` × `scripts/accept/` 交叉，
   * 见 HANDOFF §208 的零覆盖清单）—— 行内那枚置顶小旗正属于"没人点过"的那一类。
   *
   * 断**后果**：点了「置顶」之后**那一行上真出现置顶标记**（不是"点了没报错"）。
   * 顺带把顶部那颗「新工作任务」钉住（必须可点）。
   *
   * ⚠️ `wb-threads-more`（批量操作）**2026-10-15 已被移除**（M0 工单 3）：
   * 原来是"如实禁用 + 说明原因"，工单把口径改成"实现 / 移除 / 降级"三选一、
   * 不许留"disabled + 借口" —— 本机版没做批量操作，所以移除。
   * 于是这里改成断言"它不该再出现"（见下面的判定）。
   */
  out.headNew = await page.evaluate(() => {
    const e = document.querySelector('[data-testid="wb-threads-new"]');
    return e ? { title: e.getAttribute("title") ?? "", disabled: e.hasAttribute("disabled") } : null;
  });
  out.headMore = await page.evaluate(() => {
    const e = document.querySelector('[data-testid="wb-threads-more"]');
    return e ? { title: e.getAttribute("title") ?? "", disabled: e.hasAttribute("disabled") } : null;
  });
  await page.locator('[data-testid="wb-threads-menu-t-yest"]').click({ force: true });
  await page.waitForTimeout(500);
  await page.locator('[data-testid="wb-menu"] button', { hasText: "置顶" }).first().click();
  await page.waitForTimeout(900);
  out.pinnedFlag = await page.locator('[data-testid="wb-thread-pinned-t-yest"]').count();

  /*
   * ⚠️ `wb-unpin-*`（左栏置顶行上那个「取消置顶」的 ★）原来也没有脚本点过（§208）。
   * 断**后果**：点下去之后**行上的置顶标记真的没了**（不是"点了没报错"）。
   *
   * ⚠️ 2026-10-17 口径反转（V5 开工前清尾 §2.4 #3）：左栏那颗搜索键原来钉的是
   * "本机版没做搜索，必须如实禁用并说明"；现在它**真做了** —— 接 Phase 12.4 的
   * 会话全文检索（行为级回归在 `accept-navsearch.mjs`：真发一条消息→搜到→点开进任务）。
   * 这里只断"它不该再禁用 + 点了要出搜索框"（离得近，顺手钉住开合）。
   */
  out.unpinCtrl = await page.locator('[data-testid="wb-unpin-t-yest"]').count();
  if (out.unpinCtrl === 1) {
    await page.locator('[data-testid="wb-unpin-t-yest"]').click();
    await page.waitForTimeout(800);
  }
  out.pinnedFlagAfterUnpin = await page.locator('[data-testid="wb-thread-pinned-t-yest"]').count();
  out.navSearch = await page.evaluate(() => {
    const e = document.querySelector('[data-testid="wb-search"]');
    return e ? { title: e.getAttribute("title") ?? "", disabled: e.hasAttribute("disabled") } : null;
  });
  out.navSearchOpens = false;
  if (out.navSearch) {
    await page.locator('[data-testid="wb-search"]').click();
    await page.waitForTimeout(500);
    out.navSearchOpens = (await page.locator('[data-testid="wb-navsearch-input"]').count()) === 1;
    await page.keyboard.press("Escape");
    await page.waitForTimeout(250);
  }

  // 删除 → 那一行消失
  await page.locator('[data-testid="wb-threads-menu-t-30d"]').click({ force: true });
  await page.waitForTimeout(500);
  await page.locator('[data-testid="wb-menu"] button', { hasText: "删除" }).first().click();
  await page.waitForTimeout(900);
  out.deletedGone = (await page.locator('[data-testid="wb-thread-t-30d"]').count()) === 0;
  out.remaining = await page.$$eval(".wb-threads-row-title", (els) => els.map((e) => e.textContent?.trim() ?? ""));

  out.shot = await shot(page, "threads.png");
  await b.close();
} catch (e) {
  out.error = String(e).slice(0, 260);
} finally {
  console.log(JSON.stringify(out, null, 2));
  await killTree(child);

  const bad = [];
  if (!out.pageOpen) bad.push("页面没打开");
  const expectGroups = ["今天", "昨天", "近 7 天", "近 30 天", "近一年", "更早"];
  if (JSON.stringify(out.groups) !== JSON.stringify(expectGroups)) {
    bad.push(`分档不对：期望 ${expectGroups.join("/")}，实际 ${(out.groups ?? []).join("/")}`);
  }
  const inBucket = (label, title) => (out.rows ?? []).find((r) => r.label === label)?.titles?.includes(title);
  if (!inBucket("今天", "今天的对话")) bad.push("今天的对话没落在「今天」");
  if (!inBucket("昨天", "昨天的对话")) bad.push("昨天的对话没落在「昨天」");
  if (!inBucket("近 7 天", "七天内")) bad.push("4 天前的没落在「近 7 天」");
  if (!inBucket("近一年", "一年内")) bad.push("200 天前的没落在「近一年」");
  if (!inBucket("更早", "更早")) bad.push("500 天前的没落在「更早」");
  if (out.emptySummary !== "打开对话") bad.push(`空会话摘要不是「打开对话」，实际 ${out.emptySummary}`);
  /*
   * 2026-10-20（脚本过期）：行内菜单后来加了「从这一刻分叉」（fork）。
   * 断言改成**集合相等**（顺序不算契约），并把这个新动作算进来。
   */
  const expectedMenu = ["置顶", "重命名", "从这一刻分叉", "删除"];
  const gotMenu = [...(out.menuItems ?? [])].sort();
  if (JSON.stringify(gotMenu) !== JSON.stringify([...expectedMenu].sort())) {
    bad.push(`行内菜单项不对：${JSON.stringify(out.menuItems)}（期望 ${JSON.stringify(expectedMenu)}）`);
  }
  if (out.renamedAfterReload !== "改过名字的对话") bad.push(`重命名没保住（刷新后是 ${out.renamedAfterReload}）`);

  /* 补的那组（零覆盖清单里的置顶标记与顶部两颗按钮，§208） */
  if (!out.headNew) bad.push("页面顶部没有「新工作任务」按钮");
  else if (out.headNew.disabled) bad.push("⭐「新工作任务」被禁用了（点了没反应的假按钮）");
  /*
   * ⚠️ 2026-10-15（M0 工单 3）口径反转：原来钉的是"本机版没做批量操作 → 那颗「更多」
   * 必须 disabled 且有说明"，现在**那颗按钮已被移除**（工单口径：实现 / 移除 / 降级，
   * 不留"disabled + 借口"）。所以这条改成"它不该再出现"。
   */
  if (out.headMore) bad.push("⭐ 页面顶部那颗「批量操作（更多）」本该移除却还在（点了没反应 = 假按钮）");
  if (out.pinnedFlag !== 1) bad.push("点了「置顶」那一行上没有出现置顶标记");
  if (out.unpinCtrl !== 1) bad.push("左栏置顶行上没有「取消置顶」（wb-unpin-*）");
  if (out.pinnedFlagAfterUnpin !== 0) bad.push("点了「取消置顶」标记还在");
  if (!out.navSearch) bad.push("左栏没有那颗搜索键（wb-search）");
  else {
    /* 口径见上面那段注释（2026-10-17 反转）：它已经真做了，不许再是禁用的装饰 */
    if (out.navSearch.disabled) bad.push("⭐ 搜索键还是 disabled —— 它已经真做了（接入会话检索）");
    if (!out.navSearch.title) bad.push("搜索键没说它是干什么的（title 为空）");
    if (!out.navSearchOpens) bad.push("⭐ 点了搜索键没有出搜索框（wb-navsearch-input）");
  }
  if (!out.deletedGone) bad.push("删除后那一行还在");
  if (out.error) bad.push("异常: " + out.error);
  if (bad.length) {
    console.error("✗ " + bad.join("；"));
    process.exitCode = 1;
  } else {
    console.log("✓ 管理历史对话：分档 / 摘要 / 行内操作 / 刷新后仍在，全对");
  }
}
