// 删除 / 隐藏供应商（M-06，2026-10-21）—— 常驻回归。
//
// 判据：
//   ① 自定义供应商删除：确认框里的数字 = 已声明的模型数；删后 provider 与声明都没了；
//   ② 内置供应商只能隐藏：隐藏后输入区选择器里看不到，设置里能恢复。
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";
import { failOnMarks, freshDir, killLeftovers, openApp, pickPort, sleep, verdict } from "./harness.mjs";

failOnMarks();

const bad = [];
const note = (m) => console.log("   " + m);

const DATA = ".verify/accept-provider-delete-data";
if (!(await freshDir(DATA))) {
  console.error("✗ 数据目录 " + DATA + " 删不掉 —— 先手工关掉占着它的 Electron");
  process.exit(1);
}
fs.mkdirSync(DATA, { recursive: true });
/* 预置一个自定义供应商 + 两条模型声明（与 CLI 读同一份 config.json / models.json） */
fs.writeFileSync(
  path.join(DATA, "config.json"),
  JSON.stringify(
    {
      providers: [
        {
          id: "my-relay",
          label: "我的中转",
          baseURL: "http://127.0.0.1:18099/v1",
          protocol: "openai-compatible",
          keyRef: "MY_RELAY_API_KEY",
          models: ["m-a", "m-b"],
        },
      ],
    },
    null,
    1,
  ),
  "utf8",
);
const exact = (modelId) => ({
  type: "exact",
  providerId: "my-relay",
  modelId,
  config: { properties: { contextWindow: 128000 } },
  manual: true,
});
fs.writeFileSync(
  path.join(DATA, "models.json"),
  JSON.stringify({ version: 1, rules: [exact("m-a"), exact("m-b")] }, null, 1),
  "utf8",
);

const port = await pickPort([9926]);
await killLeftovers();
const { browser, page } = await openApp(chromium, { port, dataDir: DATA, cwd: "." });
await sleep(2200);

try {
  await page.locator('[data-testid="wb-account"]').click();
  await sleep(500);
  await page.locator('[data-testid="wb-acct-settings"]').click();
  await sleep(900);
  await page.locator('[data-testid="wb-set-模型"]').click();
  await sleep(1200);

  /* ① 删除自定义供应商 */
  const mine = page.locator('[data-testid="wb-modelset-provider-my-relay"]');
  if (!(await mine.count())) throw new Error("左列没有预置的自定义供应商 my-relay");
  await mine.click();
  await sleep(600);

  await page.locator('[data-testid="wb-modelset-more"]').click();
  await sleep(400);
  const del = page.locator('[data-testid="wb-modelset-menu-删除供应商"]');
  if (!(await del.count())) bad.push("自定义供应商的 ⋯ 菜单里没有「删除供应商」");
  else {
    await del.click();
    await sleep(600);
    const msg = ((await page.locator('[data-testid="wb-confirm-message"]').textContent()) ?? "").trim();
    if (!/2 个模型声明/.test(msg)) bad.push(`确认框没说清会删几条声明（实际：${msg}）`);
    else note(`确认框：${msg}`);
    await page.screenshot({ path: ".verify/mset-06-delete-confirm.png" });
    await page.locator('[data-testid="wb-confirm-ok"]').click();
    await sleep(1500);

    if (await page.locator('[data-testid="wb-modelset-provider-my-relay"]').count()) {
      bad.push("删除之后左列还有 my-relay");
    }
    const config = JSON.parse(fs.readFileSync(path.join(DATA, "config.json"), "utf8"));
    if ((config.providers ?? []).some((p) => p.id === "my-relay")) bad.push("磁盘上的 config.json 里还有 my-relay");
    const models = JSON.parse(fs.readFileSync(path.join(DATA, "models.json"), "utf8"));
    const left = (models.rules ?? []).filter((r) => r.providerId === "my-relay");
    if (left.length) bad.push(`级联没清干净：models.json 里还剩 ${left.length} 条 my-relay 声明`);
    else note("provider 与 2 条声明都已清掉 ✓");
  }

  /* ② 内置只能隐藏 */
  const builtin = page.locator('[data-testid="wb-modelset-provider-deepseek"]');
  if (!(await builtin.count())) bad.push("左列没有内置 provider（deepseek）");
  else {
    await builtin.click();
    await sleep(400);
    await page.locator('[data-testid="wb-modelset-more"]').click();
    await sleep(400);
    const hide = page.locator('[data-testid="wb-modelset-menu-隐藏（从模型选择器里消失）"]');
    const delBuiltin = page.locator('[data-testid="wb-modelset-menu-删除供应商"]');
    if (await delBuiltin.count()) bad.push("⭐ 内置供应商的菜单里出现了「删除供应商」（它只能隐藏）");
    else if (!(await hide.count())) bad.push("内置供应商的 ⋯ 菜单里没有「隐藏」");
    else {
      await hide.click();
      await sleep(500);
      await page.locator('[data-testid="wb-confirm-ok"]').click();
      await sleep(1200);
      if (!(await page.locator('[data-testid="wb-modelset-toggle-hidden"]').count())) {
        bad.push("隐藏之后没有「显示已隐藏」入口（没法恢复）");
      }
      const settingsRaw = JSON.parse(fs.readFileSync(path.join(DATA, "settings.json"), "utf8").replace(/^\uFEFF/, ""));
      /* 落盘走 jsonStore 的信封：真实数据在 `.data` 里（裸对象是更老的版本） */
      const settings = settingsRaw?.data ?? settingsRaw;
      if (!(settings.hiddenProviders ?? []).includes("deepseek")) bad.push("settings.json 里没有记下 hiddenProviders");
      else note("已隐藏 deepseek，且 settings.json 记下了 ✓");

      /* 输入区选择器里看不到 */
      await page.locator('[data-testid="wb-settings-close"]').click();
      await sleep(800);
      await page.locator('[data-testid="wb-model"]').click();
      await sleep(700);
      if (await page.locator('[data-testid="wb-model-provider-deepseek"]').count()) {
        bad.push("隐藏之后输入区选择器里还能看到 deepseek");
      } else note("输入区选择器里看不到 deepseek ✓");
    }
  }

  await page.screenshot({ path: ".verify/mset-06-after.png" });
  note("截图：.verify/mset-06-delete-confirm.png / mset-06-after.png");
} catch (e) {
  bad.push("异常: " + String(e).slice(0, 300));
} finally {
  await browser.close().catch(() => undefined);
  await killLeftovers();
}

verdict(bad, "删除/隐藏成立：自定义可删且级联清理（声明 2 条）/ 内置只能隐藏、隐藏后选择器看不见");
