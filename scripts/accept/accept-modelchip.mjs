// 主页那两颗控件（2026-10-16 第三版，主人的口径）—— 常驻回归。
//
//   「用户配置模型 他应该在设置页面里边去配置好这个模型 然后在主页的这个选择器里边 点击这个
//     选择器 能够选择模型 然后另一个按钮 它可以选择思考强度」—— 所以这里是**两颗**：
//     · 「默认通道 / provider/model」= 选模型（**没有**搜索、**没有**拉取 —— 那些归设置页）
//     · 「思考默认 / 思考X」= 选档位（与画布那处同一份状态）
//
// 判据都是"点了要有真后果"：两类 chip 都在 → 模型列表真列出来 → 选一条真落盘（`resolveChatRoute`
// 读的就是那个键）→ chip 文案跟着变 → 档位选真落盘、选回「默认」要把键**删掉**（默认 = 一个字段都不发）。
import { chromium } from "playwright";
import { failOnMarks, killLeftovers, openApp, pickPort, sleep, verdict } from "./harness.mjs";

/* ⚠️ 2026-10-16（审计 G15）：这份脚本原来只把 ✗ 印出来、从不改退出码 —— 批跑里等于没测 */
failOnMarks();

const bad = [];
const note = (m) => console.log("   " + m);

const port = await pickPort([9911]);
await killLeftovers();
const { browser, page } = await openApp(chromium, { port, dataDir: ".verify/accept-modelchip-data", cwd: "." });
await sleep(2000);

const chipText = (id) => page.locator(`[data-testid="${id}"]`).textContent().then((t) => (t ?? "").trim());
const saved = () =>
  page.evaluate(() => ({
    route: localStorage.getItem("dsh-canvas.chat-settings"),
    effort: localStorage.getItem("dsh-canvas.reasoning-effort"),
  }));

try {
  /* ① 两颗 chip 都在，文案不是编的 */
  const model0 = await chipText("wb-model");
  const effort0 = await chipText("wb-effort");
  if (!model0) bad.push("输入区没有模型 chip（wb-model）");
  if (!effort0) bad.push("输入区没有思考强度 chip（wb-effort）");
  note(`两颗 chip：${model0} ／ ${effort0}`);

  /* ② 模型弹层：一级是 provider（ZCode 的形态：多 provider 时一级列 provider、悬停展开二级模型）；
     **不许**有搜索框与拉取按钮（那是设置页的事） */
  await page.locator('[data-testid="wb-model"]').click();
  await sleep(800);
  const providers = await page.locator('[data-testid^="wb-model-provider-"]').count();
  const singleList = await page.locator('[data-testid^="wb-model-option-"]').count();
  if (providers < 1 && singleList < 1) bad.push("模型弹层里既没有 provider 也没有模型");
  const searchBoxes = await page.locator('[data-testid="wb-model-search"]').count();
  const pullButtons = await page.locator('[data-testid^="wb-model-pull-"]').count();
  if (searchBoxes || pullButtons) {
    bad.push();
  }
  /* 多 provider：悬停一级展开二级 */
  if (providers > 0) {
    await page.locator('[data-testid^="wb-model-provider-"]').first().hover();
    await sleep(500);
  }
  const options = await page.locator('[data-testid^="wb-model-option-"]').count();
  if (options < 1) bad.push("展开一级之后二级一个模型都没有");
  note();
  /* ②b ZCode 的两条细则：Ctrl+M 只唤起模型菜单；档位与模型**互斥**（开一个关另一个） */
  await page.keyboard.press("Escape");
  await sleep(400);
  /*
   * ⚠️ Ctrl+M 是 **toggle**：弹层开着时按会把它收起来（规矩是「只唤起/收起自己、不循环切换」）——
   * 所以按之前必须确认它是关着的，否则量到的是「又关了一次」（第一版就是这么红的）。
   */
  if (await page.locator('[data-testid="wb-model-pop"]').count()) {
    await page.keyboard.press("Control+m");
    await sleep(400);
  }
  await page.keyboard.press("Control+m");
  await sleep(600);
  const afterCtrlM = await page.locator('[data-testid="wb-model-pop"]').count();
  if (!afterCtrlM) bad.push("Ctrl+M 没有唤起模型菜单");
  await page.locator('[data-testid="wb-effort"]').click();
  await sleep(500);
  const modelStill = await page.locator('[data-testid="wb-model-pop"]').count();
  if (modelStill) bad.push("打开档位时模型菜单没关掉（两个 picker 应当互斥）");
  await page.keyboard.press("Escape");
  await sleep(300);
  await page.locator('[data-testid="wb-model"]').click();
  await sleep(600);
  note(`Ctrl+M 唤起 ${afterCtrlM ? "✓" : "✗"} / 互斥（开档位时模型菜单 ${modelStill ? "还在 ✗" : "已关 ✓"}）`);

  /* ③ 选一条 → 真落盘 + 文案跟着走 */
  const first = page.locator('[data-testid^="wb-model-option-"]').first();
  const picked = ((await first.getAttribute("data-testid")) ?? "").replace("wb-model-option-", "");
  await first.click();
  await sleep(500);
  const route = JSON.parse((await saved()).route ?? "{}");
  if (!picked.startsWith(`${route.provider}-`) || !picked.endsWith(`-${route.model}`)) {
    bad.push(`选了模型没落盘：点的是 ${picked}，盘上是 ${JSON.stringify(route)}`);
  }
  const model1 = await chipText("wb-model");
  if (!model1.includes(route.model ?? "?")) bad.push(`选了模型但 chip 没跟着变：${model1}`);
  note(`选模型 → 盘上 ${JSON.stringify(route)}，chip：${model1}`);

  /* ④ 档位：另一颗 chip，选高 → 落盘；选回默认 → 键删掉 */
  await page.locator('[data-testid="wb-effort"]').click();
  await sleep(600);
  const levels =
    (await page.locator('[data-testid="wb-effort-low"]').count()) +
    (await page.locator('[data-testid="wb-effort-medium"]').count()) +
    (await page.locator('[data-testid="wb-effort-high"]').count());
  const auto = await page.locator('[data-testid="wb-effort-auto"]').count();
  if (auto !== 1) bad.push("档位里没有「默认」那一项");
  if (levels !== 3) bad.push(`档位应当有 3 档，实际 ${levels}`);
  await page.locator('[data-testid="wb-effort-high"]').click();
  await sleep(400);
  if ((await saved()).effort !== "high") bad.push("选了「思考高」没落盘");
  if (!(await chipText("wb-effort")).includes("思考高")) {
    bad.push(`选了档位但 chip 没变：${await chipText("wb-effort")}`);
  }

  await page.locator('[data-testid="wb-effort"]').click();
  await sleep(500);
  await page.locator('[data-testid="wb-effort-auto"]').click();
  await sleep(400);
  if ((await saved()).effort !== null) bad.push("选「默认」应当把键删掉（默认 = 一个字段都不发）");
  note(`档位：默认 + ${levels} 档 / 选高落盘 ✓ / 选回默认删键 ✓`);
} catch (e) {
  bad.push("异常: " + String(e).slice(0, 200));
} finally {
  await browser.close().catch(() => undefined);
  await killLeftovers();
}

verdict(bad, "模型与思考强度两颗控件成立：真列模型 / 真落盘 / 文案跟着走 / 主页弹层里没有搜索与拉取");
