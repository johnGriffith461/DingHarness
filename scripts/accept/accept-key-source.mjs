// 密钥来源诚实（M-02，2026-10-21）—— 常驻回归。
//
// 主人报的第 1 条：「供应商默认有密钥」。根因是 `~/.dsh/.credentials.yaml`
// （别的程序也在用）里的 key 被当成"用户配过了"。这条脚本：
//   ① 造一个只有 `~/.dsh`、没有 `~/.ding` 的家目录 → 列表必须写「来自旧目录」；
//   ② 点「改用本应用保存」填一条 → 必须变「本应用已保存」；
//   ③ 全程不许出现旧文案「有密钥」（那正是要被替换掉的那个说法）。
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";
import { failOnMarks, freshDir, killLeftovers, openApp, pickPort, sleep, verdict } from "./harness.mjs";

failOnMarks();

const bad = [];
const note = (m) => console.log("   " + m);

const DATA = ".verify/accept-key-source-data";
const CREDS = ".verify/accept-key-source-creds";
if (!(await freshDir(DATA))) {
  console.error("✗ 数据目录 " + DATA + " 删不掉 —— 先手工关掉占着它的 Electron");
  process.exit(1);
}
await freshDir(CREDS);
fs.mkdirSync(CREDS, { recursive: true });
/*
 * 造"只有旧目录里有这条 key"：
 * 用 `DING_LEGACY_CREDENTIALS_FILE` 把**旧位置**指到临时文件，
 * 主位置指到一个不存在的文件 —— 不碰真实家目录（改 USERPROFILE 会让 Electron 起不来）。
 */
const LEGACY = path.join(CREDS, "legacy-credentials.yaml");
const PRIMARY = path.join(CREDS, "primary-credentials.yaml");
fs.writeFileSync(LEGACY, "refs:\n  STRATA_API_KEY: legacy-fake-key\n", "utf8");

const port = await pickPort([9922]);
await killLeftovers();
const { browser, page } = await openApp(chromium, {
  port,
  dataDir: DATA,
  cwd: ".",
  extraEnv: {
    DING_CREDENTIALS_FILE: PRIMARY,
    DING_LEGACY_CREDENTIALS_FILE: LEGACY,
    /* 环境变量也清空：否则来源会是 env 而不是 legacy（env 那一档由 badgeOf 的单测盯着） */
    STRATA_API_KEY: "",
    STRATA_BASE_URL: process.env.STRATA_BASE_URL ?? "http://127.0.0.1:1/v1",
  },
});
await sleep(2000);

const badgeOfRow = async () =>
  ((await page.locator('[data-testid="wb-modelset-provider-strata"] em').textContent()) ?? "").trim();

try {
  await page.locator('[data-testid="wb-account"]').click();
  await sleep(500);
  await page.locator('[data-testid="wb-acct-settings"]').click();
  await sleep(900);
  await page.locator('[data-testid="wb-set-模型"]').click();
  await sleep(1000);

  const row = page.locator('[data-testid="wb-modelset-provider-strata"]');
  if (!(await row.count())) bad.push("左列没有 strata（本地假通道那一家）");
  else {
    const text = await badgeOfRow();
    if (!text.includes("来自旧目录")) bad.push(`旧目录里的 key 没被标成「来自旧目录」（实际：${text}）`);
    if (text.includes("有密钥") && !text.includes("旧目录")) bad.push("还在用旧文案「有密钥」");
    if (text.includes("本应用已保存")) bad.push("⭐ 把 ~/.dsh 里的 key 算成了「本应用已保存」（正是主人报的第 1 条）");
    note(`旧目录来源：${text}`);

    await row.click();
    await sleep(500);
    const detailBadge = ((await page.locator('[data-testid="wb-modelconfig-detail"] .wb-mset-badge').textContent()) ?? "").trim();
    if (!detailBadge.includes("旧目录")) bad.push(`详情里的来源也不对：${detailBadge}`);

    /* ② 改用本应用保存 */
    const adopt = page.locator('[data-testid="wb-modelset-adopt-key"]');
    if (!(await adopt.count())) bad.push("旧目录来源时没有「改用本应用保存」入口");
    else {
      await adopt.click();
      await sleep(300);
      const hint = ((await page.locator('[data-testid="wb-modelset-keyhint"]').textContent()) ?? "").trim();
      if (!hint.includes("旧目录")) bad.push(`提示里没写清这条 key 来自旧目录：${hint}`);
      await page.locator('[data-testid="wb-modelset-key"]').fill("app-saved-key");
      await page.locator('[data-testid="wb-modelset-key-save"]').click();
      await sleep(1200);
      const after = await badgeOfRow();
      if (!after.includes("本应用已保存")) bad.push(`保存之后没变成「本应用已保存」（实际：${after}）`);
      else note(`保存之后：${after}`);
    }
  }

  await page.screenshot({ path: ".verify/mset-02-key-source.png" });
  note("截图：.verify/mset-02-key-source.png");
} catch (e) {
  bad.push("异常: " + String(e).slice(0, 300));
} finally {
  await browser.close().catch(() => undefined);
  await killLeftovers();
}

verdict(bad, "密钥来源诚实：旧目录标「来自旧目录」/ 改用本应用保存后变「本应用已保存」，不再把别人的 key 算成已配置");
