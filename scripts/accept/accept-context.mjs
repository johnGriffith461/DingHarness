import { chromium } from "playwright";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { connectWithRetry, readStoreFile, shot, verdict } from "./harness.mjs";

/**
 * 11.14 验收：云盘行右键菜单 + 插件「管理」子页。
 *
 * 两项都是从第三遍实机遍历里发现的（`.verify\tour3\`）：
 *   · `04-cloud-row-context.png` —— 七项右键菜单
 *   · `06-plugin-manage.png` —— 面包屑「市场 › 管理」+ 插件/技能/连接器 带计数
 *
 * 菜单里的**每一项都要能点且行为可验证** —— 「创建副本」真复制文件、
 * 「复制链接」真进剪贴板、「删除」真删；另外两项（分享 / 快捷方式）如实标注需要什么。
 *
 * ── 2026-10-14 修过期 ───────────────────────────────────────────
 * ① 菜单的 testid 前缀早就从 `wb-ctx-` 改成 **`wb-drive-menu-`**（`DriveRowMenu.tsx:98`
 *    传的 `testid="wb-drive-menu"`，`ContextMenu` 拼成 `${testid}-${label}`）——
 *    脚本还在找旧前缀，于是**第一步就超时**、整条死在门外。
 * ② 删除现在**走确认框**（证据 `drive_confirm_title_deleteFile`），
 *    脚本原来点了「删除」就以为文件没了 —— 得再点一次确认。
 *    顺带这条断言也升级了：确认框本身要说清删的是哪个文件。
 */
const DATA = "D:/DoubaoWorkClone/.verify/ctx-data";
fs.rmSync(DATA, { recursive: true, force: true });
fs.mkdirSync(path.join(DATA, "drive"), { recursive: true });
fs.writeFileSync(path.join(DATA, "drive", "季度总结.md"), "# 季度总结\n", "utf8");
fs.writeFileSync(path.join(DATA, "drive", "封面图.png"), "fake", "utf8");

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
env.DSH_CANVAS_DATA_DIR = DATA;

const child = spawn(
  "D:/DoubaoWorkClone/node_modules/electron/dist/electron.exe",
  [".", "--remote-debugging-port=9600"],
  { cwd: "D:/DoubaoWorkClone", env, stdio: ["ignore", "ignore", "ignore"] },
);
await new Promise((r) => setTimeout(r, 8000));

const browser = await connectWithRetry(chromium, "http://127.0.0.1:9600");
const ctx = browser.contexts()[0];
await ctx.grantPermissions(["clipboard-read", "clipboard-write"]).catch(() => undefined);
const pages = ctx.pages();
const page = pages.find((p) => !p.url().startsWith("devtools://")) ?? pages[0];
await page.waitForSelector('[data-testid="wb"]', { timeout: 20000 });
await page.waitForTimeout(1500);

const report = {};
try {
const shots = "D:/DoubaoWorkClone/.verify/shots-final";

/* ---------- 云盘行右键菜单 ---------- */
await page.locator('[data-testid="wb-nav-cloud"]').click();
await page.waitForTimeout(2500);

await page.locator('[data-testid="wb-file-季度总结.md"]').click({ button: "right" });
await page.waitForTimeout(700);
report.menuOpened = await page.locator('[data-testid="wb-drive-menu"]').count();
report.menuItems = await page.$$eval(".wb-ctx-item", (els) =>
  els.map((e) => ({
    /* 去掉图标后剩下的中文（给"有没有这一项"这种粗判断用）。 */
    label: e.textContent.replace(/[^\u4e00-\u9fa5]/g, ""),
    /* 原始文字（图标 + 标签）：像「AI 阅读」这种带英文的名字只有它认得出。 */
    raw: e.textContent.replace(/\s+/g, " ").trim(),
    disabled: e.disabled,
    /* 置灰的原因在 `title` 上（禁用必须说清为什么） */
    reason: e.getAttribute("title") ?? "",
  })),
);
await shot(page, path.join(shots, "wb-19-ctx.png"));

// 复制链接 —— 剪贴板里应是 dshasset://file/...
await page.locator('[data-testid="wb-drive-menu-复制链接"]').click();
await page.waitForTimeout(800);
report.clipboard = await page.evaluate(() => navigator.clipboard.readText().catch(() => "(读不到)"));
report.noteAfterCopy = await page.locator('[data-testid="wb-cloud-note"]').textContent().catch(() => null);

// 创建副本 —— 目录里应真的多一个「-副本」文件
await page.locator('[data-testid="wb-file-季度总结.md"]').click({ button: "right" });
await page.waitForTimeout(600);
await page.locator('[data-testid="wb-drive-menu-创建副本"]').click();
await page.waitForTimeout(1500);
report.duplicateOnDisk = fs.readdirSync(path.join(DATA, "drive")).sort();
report.rowsAfterDuplicate = await page.locator(".wb-tr:not(.wb-th)").count();

// 问问豆包 —— 应调起悬浮窗并带预填问题
await page.locator('[data-testid="wb-file-封面图.png"]').click({ button: "right" });
await page.waitForTimeout(600);
await page.locator('[data-testid="wb-drive-menu-问问豆包"]').click();
await page.waitForTimeout(2500);
report.floatFromDrive = await page.locator('[data-testid="wb-float"]').count();
report.floatBubble = await page.locator(".wb-float-user-bubble").first().textContent().catch(() => null);
await page.locator('[data-testid="wb-float-close"]').click().catch(() => undefined);
await page.waitForTimeout(600);

// 删除 —— 文件应从磁盘消失
await page.locator('[data-testid="wb-file-季度总结.md"]').click({ button: "right" });
await page.waitForTimeout(600);
await page.locator('[data-testid="wb-drive-menu-删除"]').click();
await page.waitForTimeout(900);
/* 删除要走确认框（不可逆动作不许一键删） */
report.confirmShown = await page.locator('[data-testid="wb-cloud-confirm"]').count();
report.confirmTitle = await page.locator('[data-testid="wb-cloud-confirm-title"]').textContent().catch(() => null);
report.confirmNames = await page.locator(".wb-cloud-dialog-sub").textContent().catch(() => null);
/* 先点取消：文件必须还在（确认框不是装饰） */
await page.locator('[data-testid="wb-cloud-confirm-cancel"]').click();
await page.waitForTimeout(700);
report.survivesCancel = fs.existsSync(path.join(DATA, "drive", "季度总结.md"));
/* 再来一次，这次确认 */
await page.locator('[data-testid="wb-file-季度总结.md"]').click({ button: "right" });
await page.waitForTimeout(600);
await page.locator('[data-testid="wb-drive-menu-删除"]').click();
await page.waitForTimeout(800);
await page.locator('[data-testid="wb-cloud-confirm-ok"]').click();
await page.waitForTimeout(1500);
report.stillExists = fs.existsSync(path.join(DATA, "drive", "季度总结.md"));
report.remainingOnDisk = fs.readdirSync(path.join(DATA, "drive")).sort();

/* ---------- 插件管理子页 ---------- */
await page.locator('[data-testid="wb-nav-plugins"]').click();
await page.waitForTimeout(1200);

// 先装一个插件与一个技能
await page.locator('[data-testid="wb-plugin-tab-技能"]').click();
await page.waitForTimeout(600);
await page.locator('[data-testid="wb-install-stock-research"]').click();
await page.waitForTimeout(700);
await page.locator('[data-testid="wb-plugin-tab-插件"]').click();
await page.waitForTimeout(600);
await page.locator('[data-testid="wb-install-feishu"]').click();
await page.waitForTimeout(900);

await page.locator('[data-testid="wb-plugin-manage"]').click();
await page.waitForTimeout(1000);
report.manageOpened = await page.locator('[data-testid="wb-page-plugins-manage"]').count();
report.crumb = await page.locator(".wb-crumb").textContent().catch(() => null);
report.manageTabs = await page.$$eval(".wb-manage-tab", (els) => els.map((e) => e.textContent.replace(/\s+/g, "")));
report.pluginTabItems = await page.$$eval('[data-testid^="wb-managed-"]', (els) =>
  els.map((e) => e.querySelector("b")?.textContent ?? ""),
);
await page.locator('[data-testid="wb-manage-tab-技能"]').click();
await page.waitForTimeout(700);
report.skillTabItems = await page.$$eval('[data-testid^="wb-managed-"]', (els) =>
  els.map((e) => e.querySelector("b")?.textContent ?? ""),
);
await page.locator('[data-testid="wb-manage-tab-连接器"]').click();
await page.waitForTimeout(700);
report.connectorEmpty = await page.locator('[data-testid="wb-manage-empty"]').textContent().catch(() => null);

await shot(page, path.join(shots, "wb-20-manage.png"));

// 面包屑回市场
await page.locator('[data-testid="wb-crumb-market"]').click();
await page.waitForTimeout(800);
report.backToMarket = await page.locator('[data-testid="wb-page-plugins"]').count();

// 移除一个（管理页的移除 = 卸载）
await page.locator('[data-testid="wb-plugin-manage"]').click();
await page.waitForTimeout(800);
// 进管理应回到默认 tab（插件），而不是记住上次停的「连接器」
report.manageTabOnReentry = await page.locator('[data-testid="wb-manage-tab-插件"]').getAttribute("class");
await page.locator('[data-testid="wb-remove-feishu"]').click();
await page.waitForTimeout(1200);
const lib = readStoreFile(path.join(DATA, "library.json"));
report.installedAfterRemove = lib.installed;

} finally {
  // 失败也把已有结果打出来 —— 一条晚失败不该丢掉全部证据
  console.log(JSON.stringify(report, null, 2));

  /*
   * ── 判定（2026-10-14 补）────────────────────────────────────────────
   *
   * 这条脚本原来打着"每一项都要能点且行为可验证"的旗号，却**一条判定都没有**：
   * 打报告就退。等它按新 testid 重新跑起来之后，把该守的后果补上。
   */
  const bad = [];
  const menu = report.menuItems ?? [];

  /* ① 菜单本身：七项、且"分享"这类做不了的要说清为什么 */
  if (!report.menuOpened) bad.push("⭐ 云盘行右键没有菜单");
  /*
   * 项数**不写死**：本体实机看到的七项之后又补了「下载」（§169）与「AI 阅读」（§158），
   * 写死 7 会让这条断言比产品更旧（红的是断言不是功能）。改成"至少七项 + 该有的都在"，
   * 下面逐个点名。
   */
  if (menu.length < 7) bad.push(`右键菜单只有 ${menu.length} 项（本体至少 7 项）`);
  for (const item of menu) {
    if (item.disabled && !item.reason) bad.push(`菜单项「${item.label}」置灰但没写原因`);
  }
  for (const need of ["复制链接", "创建副本", "删除", "问问豆包", "AI 阅读", "下载"]) {
    /* 用原始文字比：`label` 把英文滤掉了，「AI 阅读」在那里会变成「 阅读」。 */
    if (!menu.some((m) => (m.raw ?? "").includes(need))) bad.push(`菜单里没有「${need}」`);
  }

  /* ② 复制链接：剪贴板里真有一条 dshasset:// */
  if (!String(report.clipboard ?? "").startsWith("dshasset://")) {
    bad.push(`⭐ 复制链接后剪贴板里是 ${JSON.stringify(report.clipboard)}`);
  }
  if (!report.noteAfterCopy) bad.push("复制完没有任何回执（用户不知道成没成）");

  /* ③ 创建副本：磁盘上真多一个文件 + 列表多一行 */
  const dup = report.duplicateOnDisk ?? [];
  if (dup.length !== 3) bad.push(`创建副本后目录里应 3 个文件，实际 ${JSON.stringify(dup)}`);
  if (!dup.some((f) => f.includes("副本"))) bad.push("⭐ 创建副本没在磁盘上生成带「副本」的文件");

  /* ④ 问问豆包：调起悬浮窗且带上文件名 */
  if (!report.floatFromDrive) bad.push("「问问豆包」没有调起悬浮窗");
  if (!String(report.floatBubble ?? "").includes("封面图")) bad.push("悬浮窗里没有预填这个文件（点了跟没点一样）");

  /* ⑤ 删除：确认框先说清删谁；取消不能删；确认才删 */
  if (!report.confirmShown) bad.push("⭐ 点删除没有确认框（不可逆动作没有二次确认）");
  if (!report.confirmNames?.includes("季度总结")) bad.push(`确认框里没写清删的是哪个文件：${JSON.stringify(report.confirmNames)}`);
  if (!report.survivesCancel) bad.push("⭐ 点了取消但文件还是没了（确认框是装饰）");
  if (report.stillExists) bad.push("⭐ 确认删除后磁盘上的文件还在");
  if ((report.remainingOnDisk ?? []).includes("季度总结.md")) bad.push("删完列表里还留着这一行");

  /* ⑥ 插件管理子页：面包屑 + 三个 tab 计数对得上 */
  if (!report.manageOpened) bad.push("插件「管理」打不开");
  if (!String(report.crumb ?? "").includes("管理")) bad.push(`管理页没有面包屑：${JSON.stringify(report.crumb)}`);
  if ((report.manageTabs?.length ?? 0) !== 3) bad.push(`管理页应有 3 个 tab，实际 ${JSON.stringify(report.manageTabs)}`);
  if (!(report.pluginTabItems ?? []).some((t) => t.includes("飞书"))) bad.push("管理页的插件 tab 里没有刚装的飞书");
  if (!(report.skillTabItems ?? []).some((t) => t.includes("stock") || t.includes("研究"))) {
    bad.push(`管理页的技能 tab 里没有刚装的技能：${JSON.stringify(report.skillTabItems)}`);
  }
  if (!report.connectorEmpty) bad.push("连接器 tab 没有空态说明（空白一片等于坏了）");
  if (!report.backToMarket) bad.push("面包屑点回市场没回到市场页");

  /* ⑦ 移除：库文件里的 installed 真少了 */
  /*
   * ⚠️ 先取出来再判（第一版写成 `(x?.length ?? 99) >= 2` 后在下面读 `x.length`——
   * 未定义时条件成立，紧接着就抛 `Cannot read properties of undefined`，判定本身崩了）。
   */
  const keptInstalled = report.installedAfterRemove;
  if (!Array.isArray(keptInstalled)) {
    bad.push(`读不到移除后的 library.json 内容：${JSON.stringify(keptInstalled)}`);
  } else if (keptInstalled.length >= 2) {
    bad.push(`移除之后 library.json 里还有 ${keptInstalled.length} 项：${JSON.stringify(keptInstalled)}`);
  }

  verdict(bad, "云盘右键七项 + 插件管理子页成立：复制链接真进剪贴板 / 副本真落盘 / 删除有确认且取消不删 / 管理页三 tab 计数对得上 / 移除真写库");

  await browser.close().catch(() => undefined);
  child.kill();
  process.exit(process.exitCode ?? 0);
}
await browser.close();
child.kill();
