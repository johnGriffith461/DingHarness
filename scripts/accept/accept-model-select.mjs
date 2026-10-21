// 模型启用清单（M-05，2026-10-21）—— 常驻回归。
//
// 主人报的第 3 条：拉取模型默认全选。判据：
//   ① 拉取后 **0 个勾**；
//   ② 勾 2 个；
//   ③ 输入区那颗选择器里**只出现那 2 个**（<code>enabled</code> 是唯一依据）。
import { chromium } from "playwright";
import { failOnMarks, freshDir, killLeftovers, openApp, pickPort, sleep, verdict } from "./harness.mjs";

failOnMarks();

const bad = [];
const note = (m) => console.log("   " + m);

const DATA = ".verify/accept-model-select-data";
if (!(await freshDir(DATA))) {
  console.error("✗ 数据目录 " + DATA + " 删不掉 —— 先手工关掉占着它的 Electron");
  process.exit(1);
}

const port = await pickPort([9925]);
await killLeftovers();
const { browser, page } = await openApp(chromium, { port, dataDir: DATA, cwd: "." });
await sleep(2000);

try {
  await page.locator('[data-testid="wb-account"]').click();
  await sleep(500);
  await page.locator('[data-testid="wb-acct-settings"]').click();
  await sleep(900);
  await page.locator('[data-testid="wb-set-模型"]').click();
  await sleep(1000);

  await page.locator('[data-testid="wb-modelset-provider-strata"]').click();
  await sleep(400);

  /* ① 同步模型 */
  await page.locator('[data-testid="wb-modelset-pull"]').click();
  await sleep(2500);
  const toggles = page.locator('[data-testid^="wb-modelset-toggle-"]');
  const total = await toggles.count();
  if (total < 2) bad.push(`同步之后模型少于 2 个（${total}）—— 假通道应给两个`);
  const checked = await page.locator('[data-testid^="wb-modelset-toggle-"].is-on').count();
  if (checked !== 0) bad.push(`⭐ 拉取之后默认勾了 ${checked} 个（主人报的第 3 条）`);
  else note(`拉回 ${total} 个模型，默认 0 勾 ✓`);

  /* ② 勾前两个 */
  const ids = await toggles.evaluateAll((els) =>
    els.map((e) => e.getAttribute("data-testid") ?? "").map((t) => t.replace("wb-modelset-toggle-", "")),
  );
  const picked = ids.slice(0, 2);
  for (const id of picked) {
    await page.locator(`[data-testid="wb-modelset-toggle-${id}"]`).click();
    await sleep(200);
  }
  const after = await page.locator('[data-testid^="wb-modelset-toggle-"].is-on').count();
  if (after !== 2) bad.push(`勾了 2 个但界面显示 ${after} 个勾`);
  else note(`已启用：${picked.join(" / ")}`);

  /* ③ 输入区选择器只出那两个 */
  await page.locator('[data-testid="wb-settings-close"]').click();
  await sleep(800);
  await page.locator('[data-testid="wb-model"]').click();
  await sleep(700);
  /* 多渠道时一级是 provider（rail），悬停展开二级模型 */
  const branch = page.locator('[data-testid="wb-model-provider-strata"]');
  if (await branch.count()) {
    await branch.hover();
    await sleep(500);
  }
  const optionIds = await page
    .locator('[data-testid^="wb-model-option-"]')
    .evaluateAll((els) => els.map((e) => e.getAttribute("data-testid") ?? ""));
  const strataOptions = optionIds.filter((id) => id.includes("-strata-")).map((id) => id.replace("wb-model-option-strata-", ""));
  if (strataOptions.length !== 2) {
    bad.push(`输入区选择器里 strata 出现 ${strataOptions.length} 个模型（应为 2）`);
  } else if (!picked.every((id) => strataOptions.includes(id))) {
    bad.push(`选择器里的两个不是刚勾的那两个（实际：${strataOptions.join(" / ")}）`);
  } else {
    note(`选择器只出现刚勾的两个：${strataOptions.join(" / ")}`);
  }

  await page.screenshot({ path: ".verify/mset-05-model-select.png" });
  note("截图：.verify/mset-05-model-select.png");
} catch (e) {
  bad.push("异常: " + String(e).slice(0, 300));
} finally {
  await browser.close().catch(() => undefined);
  await killLeftovers();
}

verdict(bad, "模型启用清单成立：拉取后 0 勾 / 勾 2 个 / 输入区选择器只出现那 2 个");
