// 模型页三段式布局（M-01，2026-10-21）—— 常驻回归。
//
// 判据（与方案 §2 判定标准 1 一一对应）：
//   ① 左列存在（`wb-modelset-list`）、详情存在（`wb-modelconfig-detail`）；
//   ② **API Key 输入框在模型清单上方**（比较 boundingBox().y）—— Cherry 的"Key 置顶"；
//   ③ 两个弹窗都不许是 `wb-setfull`（整页覆盖），必须是 `wb-modal-card`；
//   ④ 截图存 `.verify/mset-01-layout.png`。
import { chromium } from "playwright";
import { failOnMarks, freshDir, killLeftovers, openApp, pickPort, sleep, verdict } from "./harness.mjs";

failOnMarks();

const bad = [];
const note = (m) => console.log("   " + m);

const DATA = ".verify/accept-models-layout-data";
if (!(await freshDir(DATA))) {
  console.error("✗ 数据目录 " + DATA + " 删不掉 —— 先手工关掉占着它的 Electron");
  process.exit(1);
}

const port = await pickPort([9921]);
await killLeftovers();
const { browser, page } = await openApp(chromium, { port, dataDir: DATA, cwd: "." });
await sleep(2000);

try {
  await page.locator('[data-testid="wb-account"]').click();
  await sleep(500);
  await page.locator('[data-testid="wb-acct-settings"]').click();
  await sleep(900);
  const row = page.locator('[data-testid="wb-set-模型"]');
  if (!(await row.count())) bad.push("设置列表里没有「模型」这一行");
  else {
    await row.click();
    await sleep(1000);
  }

  const list = page.locator('[data-testid="wb-modelset-list"]');
  const detail = page.locator('[data-testid="wb-modelconfig-detail"]');
  if (!(await list.count())) bad.push("左列不存在（wb-modelset-list）");
  if (!(await detail.count())) bad.push("详情不存在（wb-modelconfig-detail）");

  /* ⭐ Key 在模型清单上方（主人报的第 4 条：Key 原来在页底） */
  const key = page.locator('[data-testid="wb-modelset-key"]');
  const models = page.locator('[data-testid="wb-modelset-models"]');
  if (!(await key.count())) bad.push("详情里没有 API Key 输入框（wb-modelset-key）");
  else if (!(await models.count())) bad.push("详情里没有模型清单（wb-modelset-models）");
  else {
    const keyBox = await key.first().boundingBox();
    const modelsBox = await models.first().boundingBox();
    if (!keyBox || !modelsBox) bad.push("量不到 Key / 模型区的位置（元素可能不可见）");
    else if (!(keyBox.y < modelsBox.y)) bad.push(`API Key 不在模型清单上方（key.y=${keyBox.y}，models.y=${modelsBox.y}）`);
    else note(`Key 在模型区上方：${Math.round(keyBox.y)} < ${Math.round(modelsBox.y)}`);
  }

  /* ⭐ 添加供应商是小窗（不是整页 wb-setfull） */
  await page.locator('[data-testid="wb-modelset-new-provider"]').click();
  await sleep(600);
  const np = page.locator('[data-testid="wb-newprovider-dialog"]');
  if (!(await np.count())) bad.push("点「添加供应商」没出现弹窗");
  else {
    const cls = (await np.getAttribute("class")) ?? "";
    if (!cls.includes("wb-modal-card")) bad.push(`添加供应商弹窗不是卡片（class=${cls}）`);
    if (cls.includes("wb-setfull")) bad.push("添加供应商弹窗还在用 wb-setfull（整页覆盖）");
    const width = (await np.boundingBox())?.width ?? 0;
    if (width < 520 || width > 680) bad.push(`添加供应商弹窗宽度 ${Math.round(width)} 不在 520–680`);
    else note(`添加供应商小窗宽度 ${Math.round(width)}`);
    await page.locator('[data-testid="wb-newprovider-cancel"]').click();
    await sleep(300);
  }

  /* ⭐ 添加模型也是小窗 + 五字段顺序 */
  await page.locator('[data-testid="wb-modelset-add"]').click();
  await sleep(600);
  const md = page.locator('[data-testid="wb-modelconfig-dialog"]');
  if (!(await md.count())) bad.push("点「添加模型」没出现弹窗");
  else {
    const cls = (await md.getAttribute("class")) ?? "";
    if (!cls.includes("wb-modal-card")) bad.push(`添加模型弹窗不是卡片（class=${cls}）`);
    if (cls.includes("wb-setfull")) bad.push("添加模型弹窗还在用 wb-setfull");
    const width = (await md.boundingBox())?.width ?? 0;
    if (width < 520 || width > 680) bad.push(`添加模型弹窗宽度 ${Math.round(width)} 不在 520–680`);
    const order = ["field-model", "field-context", "field-output", "field-modalities"];
    const ys = [];
    for (const key of order) {
      const box = await page.locator(`[data-testid="wb-modelconfig-${key}"]`).boundingBox();
      if (!box) bad.push(`五字段里的 ${key} 不可见`);
      else ys.push(box.y);
    }
    if (ys.length === order.length && !ys.every((y, i) => i === 0 || y > ys[i - 1])) {
      bad.push(`字段顺序不是模型→上下文→输出→输入类型（y=${ys.map(Math.round).join("/")}）`);
    }
    await page.locator('[data-testid="wb-modelconfig-cancel"]').click();
    await sleep(300);
  }

  await page.screenshot({ path: ".verify/mset-01-layout.png" });
  note("截图：.verify/mset-01-layout.png");
} catch (e) {
  bad.push("异常: " + String(e).slice(0, 300));
} finally {
  await browser.close().catch(() => undefined);
  await killLeftovers();
}

verdict(bad, "模型页三段式成立：左列/详情分离、Key 在模型区上方、两个弹窗都是 520–680 的卡片");
