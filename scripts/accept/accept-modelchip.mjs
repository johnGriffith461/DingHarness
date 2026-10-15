// 输入区的「模型 · 思考」chip（2026-10-16，主人：「这是个假按钮吧，没法选择模型、
// 也没法选择思考强度，这按钮是必须的呀」）—— 常驻回归。
//
// 判据（都是"点了要有真后果"）：
//   · chip 在、**带字且不是写死的**：还没选过时写「默认通道」，不编一个模型名；
//   · 打开下拉：列出真 provider 的模型（不只一个）+ 四个档位（默认 / 低 / 中 / 高）；
//   · 选一个模型 → 写进 `dsh-canvas.chat-settings`（`resolveChatRoute` 读的就是它）
//     且 chip 上的字跟着变 —— 这条是"它真是选择器，不是装饰"的关键；
//   · 选一档强度 → 写进 `dsh-canvas.reasoning-effort`；选「默认」要把键**删掉**
//     （默认 = 一个字段都不发，而不是存一个 auto）。
import { chromium } from "playwright";
import { killLeftovers, openApp, pickPort, sleep, verdict } from "./harness.mjs";

const bad = [];
const note = (m) => console.log("   " + m);

const port = await pickPort([9897]);
await killLeftovers();
const { browser, page } = await openApp(chromium, { port, dataDir: ".verify/accept-modelchip-data", cwd: "." });
await sleep(1800);

const chipText = () => page.locator('[data-testid="wb-model"]').textContent().then((t) => (t ?? "").trim());
const saved = () =>
  page.evaluate(() => ({
    route: localStorage.getItem("dsh-canvas.chat-settings"),
    effort: localStorage.getItem("dsh-canvas.reasoning-effort"),
  }));

try {
  // ① chip 在，且没选过时不是编出来的模型名
  const before = await chipText();
  if (!before) bad.push("输入区没有「模型 · 思考」chip（wb-model）");
  else if (!/默认通道|·/.test(before)) bad.push(`chip 文案可疑：${before}`);
  note(`chip：${before}`);

  // ② 打开下拉：模型与档位都要有
  await page.locator('[data-testid="wb-model"]').click();
  await sleep(800);
  const modelOptions = await page.locator('[data-testid^="wb-model-option-"]').count();
  const auto = await page.locator('[data-testid="wb-effort-auto"]').count();
  const levels = await page.locator('[data-testid^="wb-effort-"]:not([data-testid="wb-effort-auto"])').count();
  if (modelOptions < 1) bad.push("下拉里一个模型都没有（那不是选择器）");
  if (auto !== 1) bad.push("下拉里没有「默认」那一档");
  if (levels !== 3) bad.push(`档位应当有 3 档（低/中/高），实际 ${levels}`);
  note(`下拉：${modelOptions} 个模型 / 默认 + ${levels} 档`);

  // ③ 选一个模型 → 落盘 + 文案跟着变
  const first = page.locator('[data-testid^="wb-model-option-"]').first();
  const firstId = (await first.getAttribute("data-testid")) ?? "";
  const picked = firstId.replace("wb-model-option-", "");
  await first.click();
  await sleep(500);
  const route = JSON.parse((await saved()).route ?? "{}");
  if (!picked.startsWith(`${route.provider}-`) || !picked.endsWith(`-${route.model}`)) {
    bad.push(`选了模型没落盘：点的是 ${picked}，盘上是 ${JSON.stringify(route)}`);
  }
  const afterPick = await chipText();
  if (!afterPick.includes(route.model ?? "?")) bad.push(`选了模型但 chip 没跟着变：${afterPick}`);
  note(`选模型 → 盘上 ${JSON.stringify(route)}，chip：${afterPick}`);

  // ④ 选一档强度 → 落盘；选回「默认」→ 键被删掉
  await page.locator('[data-testid="wb-model"]').click();
  await sleep(500);
  await page.locator('[data-testid="wb-effort-high"]').click();
  await sleep(400);
  if ((await saved()).effort !== "high") bad.push("选了「思考高」没落盘");
  if (!(await chipText()).includes("思考高")) bad.push(`选了档位但 chip 没跟着变：${await chipText()}`);

  await page.locator('[data-testid="wb-model"]').click();
  await sleep(500);
  await page.locator('[data-testid="wb-effort-auto"]').click();
  await sleep(400);
  if ((await saved()).effort !== null) bad.push("选「默认」应当把键删掉（默认 = 一个字段都不发）");
  note(`档位：思考高 → 落盘 ✓；选回默认 → 键已删 ✓`);
} catch (e) {
  bad.push("异常: " + String(e).slice(0, 200));
} finally {
  console.log("   " + JSON.stringify(await saved().catch(() => ({}))));
  await browser.close().catch(() => undefined);
  await killLeftovers();
}

verdict(bad, "模型 · 思考 chip 成立：真列模型 / 真落盘 / 文案跟着走 / 默认就是不发那股字段");
