// 添加供应商 = 小窗 + URL → Key → 模型（M-03，2026-10-21）—— 常驻回归。
//
// 判据：
//   ① 根节点 class 含 `wb-modal-card`、**不含** `wb-setfull`；
//   ② 拉取前 0 个选中（主人报的第 3 条：默认全选）；
//   ③ 勾 1 个 → 保存 → 左列出现，且标「本应用已保存」；
//   ④ 新供应商的启用清单是 0（勾选只表示"端点有这些模型"，启用归设置页模型区）。
import { chromium } from "playwright";
import { failOnMarks, freshDir, killLeftovers, openApp, pickPort, sleep, verdict } from "./harness.mjs";

failOnMarks();

const bad = [];
const note = (m) => console.log("   " + m);

const DATA = ".verify/accept-new-provider-data";
if (!(await freshDir(DATA))) {
  console.error("✗ 数据目录 " + DATA + " 删不掉 —— 先手工关掉占着它的 Electron");
  process.exit(1);
}

const port = await pickPort([9923]);
await killLeftovers();
/* 假通道的地址由批跑注入（`STRATA_BASE_URL`）；单独跑时退回本机 8080 */
const FAKE = process.env.STRATA_BASE_URL ?? "http://127.0.0.1:8080/v1";
const { browser, page } = await openApp(chromium, { port, dataDir: DATA, cwd: "." });
await sleep(2000);

try {
  await page.locator('[data-testid="wb-account"]').click();
  await sleep(500);
  await page.locator('[data-testid="wb-acct-settings"]').click();
  await sleep(900);
  await page.locator('[data-testid="wb-set-模型"]').click();
  await sleep(1000);

  await page.locator('[data-testid="wb-modelset-new-provider"]').click();
  await sleep(600);
  const dlg = page.locator('[data-testid="wb-newprovider-dialog"]');
  if (!(await dlg.count())) throw new Error("点「添加供应商」没出现弹窗");

  const cls = (await dlg.getAttribute("class")) ?? "";
  if (!cls.includes("wb-modal-card")) bad.push(`弹窗不是卡片（class=${cls}）`);
  if (cls.includes("wb-setfull")) bad.push("弹窗还在用 wb-setfull（整页覆盖）");
  const box = await dlg.boundingBox();
  if (!box || box.width < 520 || box.width > 680) bad.push(`弹窗宽度 ${Math.round(box?.width ?? 0)} 不在 520–680`);

  /* 字段顺序：URL → Key（比较 y 坐标） */
  const url = page.locator('[data-testid="wb-newprovider-baseurl"]');
  const key = page.locator('[data-testid="wb-newprovider-key"]');
  const urlBox = await url.boundingBox();
  const keyBox = await key.boundingBox();
  if (!urlBox || !keyBox || !(urlBox.y < keyBox.y)) bad.push("字段顺序不是 URL 在上、Key 在下");

  /* 模型与格式收在「高级」里（默认收起 → 高级内容不可见） */
  const adv = page.locator('[data-testid="wb-newprovider-advanced"]');
  if (!(await adv.count())) bad.push("没有「高级」折叠区（名字与格式该收在里面）");

  await url.fill(FAKE);
  await key.fill("accept-local-fake");
  await page.locator('[data-testid="wb-newprovider-fetch"]').click();
  await sleep(2500);

  const picks = page.locator('[data-testid^="wb-newprovider-pick-"]');
  const count = await picks.count();
  if (!count) bad.push(`拉取之后没有模型清单（假通道应给两个）—— 见弹窗里的错误提示`);
  else {
    const selected = await page.locator('[data-testid^="wb-newprovider-pick-"].is-on').count();
    if (selected !== 0) bad.push(`⭐ 拉取后默认选中了 ${selected} 个（主人报的第 3 条：必须 0 个）`);
    note(`拉回 ${count} 个模型，默认选中 ${selected} 个`);

    /* 勾第一个 */
    await picks.first().click();
    await sleep(300);
    await page.locator('[data-testid="wb-newprovider-save"]').click();
    await sleep(1500);

    const rows = await page.locator('[data-testid^="wb-modelset-provider-"]').count();
    const providerIds = await page
      .locator('[data-testid^="wb-modelset-provider-"]')
      .evaluateAll((els) => els.map((e) => e.getAttribute("data-testid")));
    const mine = providerIds.find((id) => id && id.includes("127-0-0-1")) ?? providerIds[providerIds.length - 1];
    if (!mine) bad.push("保存之后左列没有新供应商");
    else {
      const text = ((await page.locator(`[data-testid="${mine}"] em`).textContent()) ?? "").trim();
      if (!text.includes("本应用已保存")) bad.push(`新供应商的状态不是「本应用已保存」（实际：${text}）`);
      note(`新供应商：${mine} → ${text}`);
    }

    const settings = await page.evaluate(() => localStorage.getItem("dsh-canvas.model-settings"));
    const parsed = JSON.parse(settings ?? "{}");
    const entry = Object.values(parsed).find((v) => Array.isArray(v?.enabled) && v.models?.length);
    if (!entry) bad.push("保存后 localStorage 里没有这家供应商的模型设置");
    else if (entry.enabled.length !== 0) bad.push(`⭐ 新供应商的启用清单不是空的（${entry.enabled.length} 个）`);
    else note(`启用清单 0 个（模型 ${entry.models.length} 个）—— 与「不替用户勾」一致`);
    note(`左列 ${rows} 家`);
  }

  await page.screenshot({ path: ".verify/mset-03-new-provider.png" });
  note("截图：.verify/mset-03-new-provider.png");
} catch (e) {
  bad.push("异常: " + String(e).slice(0, 300));
} finally {
  await browser.close().catch(() => undefined);
  await killLeftovers();
}

verdict(bad, "添加供应商成立：小窗 560 / URL→Key→模型 / 拉取后 0 选中 / 保存后标「本应用已保存」且启用清单为空");
