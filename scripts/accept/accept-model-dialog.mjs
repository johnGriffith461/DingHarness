// 添加模型 = 小窗 + 五字段 + 能力自动预填（M-04，2026-10-21）—— 常驻回归。
//
// 判据：
//   ① `wb-modal-card`、宽度 640、不含 `wb-setfull`；
//   ② 五字段 y 坐标递增：模型 → 上下文 → 输出 → 输入类型 → 思考强度；
//   ③ 模型是 `select`（数据源=已拉取清单），不是手打 input；
//   ④ 页面上不再出现「已声明」字样（那张独立卡已并入模型行徽标）；
//   ⑤ 选中模型后窗口自动带出，且来源那行小字写的是「模型目录」；
//   ⑥ 保存后模型行出现能力徽标。
import { chromium } from "playwright";
import { failOnMarks, freshDir, killLeftovers, openApp, pickPort, sleep, verdict } from "./harness.mjs";

failOnMarks();

const bad = [];
const note = (m) => console.log("   " + m);

const DATA = ".verify/accept-model-dialog-data";
if (!(await freshDir(DATA))) {
  console.error("✗ 数据目录 " + DATA + " 删不掉 —— 先手工关掉占着它的 Electron");
  process.exit(1);
}

const port = await pickPort([9924]);
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

  /* 选 strata（本机假通道；有密钥、有模型） */
  const strata = page.locator('[data-testid="wb-modelset-provider-strata"]');
  if (await strata.count()) {
    await strata.click();
    await sleep(500);
  }

  const pageText = (await page.locator('[data-testid="wb-modelset"]').textContent()) ?? "";
  if (pageText.includes("已声明")) bad.push("⭐ 页面上还有「已声明」字样（那张卡该删掉、能力并入模型行）");

  await page.locator('[data-testid="wb-modelset-add"]').click();
  await sleep(700);
  const dlg = page.locator('[data-testid="wb-modelconfig-dialog"]');
  if (!(await dlg.count())) throw new Error("点「添加模型」没出现弹窗");
  const cls = (await dlg.getAttribute("class")) ?? "";
  if (!cls.includes("wb-modal-card")) bad.push(`弹窗不是卡片（class=${cls}）`);
  if (cls.includes("wb-setfull")) bad.push("弹窗还在用 wb-setfull");
  const width = (await dlg.boundingBox())?.width ?? 0;
  if (width < 520 || width > 680) bad.push(`弹窗宽度 ${Math.round(width)} 不在 520–680`);
  else note(`弹窗宽度 ${Math.round(width)}`);

  /* 模型是 select（不是手打 input） */
  const selects = await page.locator('[data-testid="wb-modelconfig-model-select"]').count();
  if (!selects) bad.push("⭐ 模型字段不是下拉（已拉取清单时该用 select）");
  else note("模型字段是下拉 ✓");

  /* 选中一个模型 → 自动预填 */
  if (selects) {
    const options = await page.locator('[data-testid="wb-modelconfig-model-select"] option').evaluateAll((els) =>
      els.map((e) => e.getAttribute("value")).filter((v) => v && v !== "__manual__"),
    );
    if (!options.length) bad.push("模型下拉里没有任何模型（没拉到清单？）");
    else {
      await page.locator('[data-testid="wb-modelconfig-model-select"]').selectOption(options[0]);
      await sleep(500);
      const windowValue = await page.locator('[data-testid="wb-modelconfig-window"]').inputValue();
      if (!windowValue || Number(windowValue) <= 0) bad.push("选中模型后窗口没有自动填");
      else note(`自动预填窗口：${windowValue}`);
      const source = ((await page.locator('[data-testid="wb-modelconfig-source"]').textContent()) ?? "").trim();
      if (!/模型目录|端点返回|已手动修改/.test(source)) bad.push(`来源那行没写清（实际：${source}）`);
      else note(`来源：${source}`);
    }
  }

  /* 五字段顺序 */
  const order = ["field-model", "field-context", "field-output", "field-modalities", "field-reasoning"];
  const ys = [];
  for (const key of order) {
    const box = await page.locator(`[data-testid="wb-modelconfig-${key}"]`).boundingBox();
    if (!box) bad.push(`${key} 不可见（五字段顺序不完整）`);
    else ys.push(box.y);
  }
  if (ys.length === order.length && !ys.every((y, i) => i === 0 || y > ys[i - 1])) {
    bad.push(`字段顺序不对（y=${ys.map(Math.round).join("/")}）`);
  } else if (ys.length === order.length) {
    note(`五字段顺序：${ys.map(Math.round).join(" → ")}`);
  }

  /* 高级默认收起（内容不可见） */
  const mapVisible = await page.locator('[data-testid="wb-modelconfig-reasoning-map"]').isVisible().catch(() => false);
  if (mapVisible) bad.push("「高级」默认没收起（推理参数映射一眼就能看到）");

  /* 保存前先照两张（640 正常宽度 + 420 窄窗，验它不溢出） */
  await page.screenshot({ path: ".verify/mset-04-model-dialog.png" });
  const wide = await page.viewportSize();
  await page.setViewportSize({ width: 420, height: wide?.height ?? 800 });
  await sleep(400);
  const narrowBox = await dlg.boundingBox();
  if (narrowBox && narrowBox.width > 420) bad.push(`窄窗（420）下弹窗宽 ${Math.round(narrowBox.width)} 溢出了`);
  await page.screenshot({ path: ".verify/mset-04-model-dialog-420.png" });
  await page.setViewportSize({ width: wide?.width ?? 1280, height: wide?.height ?? 800 });
  await sleep(300);
  note("截图：.verify/mset-04-model-dialog.png / -420.png");

  /* 保存 → 模型行出现能力徽标 */
  const modelId = await page.locator('[data-testid="wb-modelconfig-model-select"]').inputValue().catch(() => "");
  await page.locator('[data-testid="wb-modelconfig-save"]').click();
  await sleep(1500);
  const dialogGone = (await page.locator('[data-testid="wb-modelconfig-dialog"]').count()) === 0;
  if (!dialogGone) bad.push("保存后弹窗没关（可能校验没通过）");
  else {
    const meta = page.locator(`[data-testid="wb-modelset-meta-${modelId}"]`);
    if (!(await meta.count())) bad.push(`保存之后模型行没有摘要（${modelId}）`);
    else {
      const text = ((await meta.first().textContent()) ?? "").trim();
      if (!/窗口/.test(text)) bad.push(`模型行摘要里没有窗口：${text}`);
      else note(`模型行：${text}`);
    }
    const caps = await page.locator(`[data-testid="wb-modelset-models"] .wb-mset-cap`).count();
    if (!caps) bad.push("模型行没有能力徽标（思考/工具/视觉）");
    else note(`能力徽标 ${caps} 个`);
  }

  await page.screenshot({ path: ".verify/mset-04-model-saved.png" });
  note("截图：.verify/mset-04-model-saved.png");
} catch (e) {
  bad.push("异常: " + String(e).slice(0, 300));
} finally {
  await browser.close().catch(() => undefined);
  await killLeftovers();
}

verdict(bad, "添加模型成立：小窗 640 / 模型下拉 / 五字段顺序 / 能力自动预填且来源可见 / 保存后带徽标 / 页面上没有「已声明」");
