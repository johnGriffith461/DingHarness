import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";
import { NO_PAGE_HINT, bootApp, connectWithRetry, freshDir, killTree, shot, waitForPage } from "./harness.mjs";

/**
 * 验收：**像真人一样从零接一个新供应商**（T0，真 provider）。
 *
 * 流程完全按用户会做的顺序：
 *   1. 设置 → 模型 → 「+ 新供应商」
 *   2. 填名字、Base URL、选 API 格式、填 API Key
 *   3. 点「拉取模型」——**真的问对方**（`GET /models`）
 *   4. 勾一个模型 → 保存
 *   5. 回列表，点「测试连通」——**真的发一轮**
 *
 * ## 为什么整条都要真打
 *
 * 这条链路每一格都有"看起来成功"的假象：
 * 假服务器能让拉取返回编造的模型名；假探测能让"测试连通"恒绿。
 * 而用户按这两个按钮，要的正是"这家中转到底通不通、它到底有哪些模型"。
 *
 * 需要 `--yes-spend`。
 */
const DATA = ".verify/newprovider-data";
const PROVIDER = process.env.ACCEPT_PROVIDER ?? "tokenrhythm";
const MODEL = process.env.ACCEPT_MODEL ?? "deepseek-v4.1-flash-1017";
const PORT = 9375;

if (!process.argv.includes("--yes-spend")) {
  process.stdout.write(
    `计划：真应用里从零接一个供应商（${PROVIDER}）\n` +
      `  ① 填地址/格式/密钥 → 真拉模型清单 → 勾一个 → 保存\n` +
      `  ② 点「测试连通」→ 真发一轮最小请求\n` +
      `  确认后加 --yes-spend\n`,
  );
  process.exit(2);
}
if (process.env.DING_NO_REAL_MODEL?.trim() || process.env.DSH_NO_REAL_MODEL?.trim()) {
  process.stderr.write("零出网闸开着：这条要真打 provider，先取消再跑\n");
  process.exit(2);
}

if (!(await freshDir(DATA))) {
  console.error("✗ 数据目录 " + DATA + " 删不掉 —— 先手工关掉占着它的 Electron");
  process.exit(1);
}

/* 真 key：只读用户已有凭据文件里的 A_API_KEY，不复制、不打印明文 */
const apiKey = (() => {
  const home = process.env.USERPROFILE ?? process.env.HOME ?? "";
  for (const file of [
    path.join(home, ".ding", ".credentials.yaml"),
    path.join(home, ".dsh", ".credentials.yaml"),
  ]) {
    if (!fs.existsSync(file)) continue;
    const m = /^\s*A_API_KEY:\s*(\S+)/m.exec(fs.readFileSync(file, "utf8"));
    if (m) return m[1];
  }
  return "";
})();
if (!apiKey) {
  console.error("✗ 本机凭据文件里没有 A_API_KEY —— 这条要真 key");
  process.exit(2);
}

const out = {};
let child = null;
const baseURL = process.env.ACCEPT_BASE_URL ?? "https://tokenrhythm.studio/v1";

try {
  const first = await bootApp({ port: PORT, dataDir: DATA, timeoutMs: 30000 });
  child = first.child;
  if (!first.ok) throw new Error("启动失败：" + (first.getLog() || "").slice(-800));
  const browser = await connectWithRetry(chromium, `http://127.0.0.1:${PORT}`);
  const page = await waitForPage(browser);
  if (!page) throw new Error(NO_PAGE_HINT);
  await page.waitForSelector('[data-testid="wb"]', { timeout: 20000 });
  await page.waitForTimeout(1500);

  /* 设置 → 模型 */
  await page.locator('[data-testid="wb-account"]').click();
  await page.waitForTimeout(600);
  await page.locator('[data-testid="wb-acct-settings"]').click();
  await page.waitForTimeout(800);
  const modelsTab = page.locator('[data-testid="wb-set-模型"]');
  if (await modelsTab.count()) {
    await modelsTab.click();
    await page.waitForTimeout(700);
  }

  /* ① 新供应商 */
  await page.locator('[data-testid="wb-modelset-new-provider"]').click();
  await page.waitForTimeout(600);
  out.dialogOpened = (await page.locator('[data-testid="wb-newprovider-dialog"]').count()) > 0;
  if (!out.dialogOpened) throw new Error("「新供应商」对话框没出来");

  await page.locator('[data-testid="wb-newprovider-label"]').fill("验收中转");
  await page.locator('[data-testid="wb-newprovider-baseurl"]').fill(baseURL);
  await page.locator('[data-testid="wb-newprovider-format"]').selectOption("openai-compatible");
  await page.locator('[data-testid="wb-newprovider-key"]').fill(apiKey);

  /* ② 真拉模型 */
  await page.locator('[data-testid="wb-newprovider-fetch"]').click();
  await page
    .locator('[data-testid="wb-newprovider-models"]')
    .waitFor({ timeout: 60000 })
    .catch(() => undefined);
  const listed = await page.locator('[data-testid="wb-newprovider-models"] .wb-modelset-modelname').allTextContents();
  out.fetchedCount = listed.length;
  out.fetchedHasRealModel = listed.includes(MODEL);
  out.fetchedSample = listed.slice(0, 5);

  /* ③ 勾目标模型并保存 */
  if (out.fetchedHasRealModel) {
    await page.locator(`[data-testid="wb-newprovider-pick-${MODEL}"]`).click();
  }
  await page.locator('[data-testid="wb-newprovider-save"]').click();
  await page.waitForTimeout(1200);
  out.dialogClosed = (await page.locator('[data-testid="wb-newprovider-dialog"]').count()) === 0;

  /* ④ 配置真的落盘了？ */
  const configFile = path.join(DATA, "config.json");
  let cfg = null;
  if (fs.existsSync(configFile)) {
    const raw = JSON.parse(fs.readFileSync(configFile, "utf8"));
    cfg = raw && typeof raw === "object" && "data" in raw ? raw.data : raw;
  }
  const added = (cfg?.providers ?? [])[0];
  out.providerSaved = Boolean(added);
  out.providerProtocol = added?.protocol ?? null;
  out.providerModels = added?.models ?? [];
  out.keyRef = added?.keyRef ?? null;

  /* ⑤ 新供应商出现在 provider 卡里，选中它再点「测试连通」 */
  await page.waitForTimeout(800);
  const card = page.locator('[data-testid="wb-modelset-list"]');
  out.newProviderListed = (await card.textContent())?.includes("验收中转") ?? false;

  const listBtn = page.locator('[data-testid="wb-modelset-list"] button', { hasText: "验收中转" }).first();
  if (await listBtn.count()) {
    await listBtn.click();
    await page.waitForTimeout(700);
  }

  /* 给它声明能力（真跑一轮需要窗口） */
  const addModel = page.locator('[data-testid="wb-modelset-add"]');
  if (await addModel.count()) {
    await addModel.click();
    await page.waitForTimeout(600);
    await page.locator('[data-testid="wb-modelconfig-id"]').fill(MODEL);
    await page.locator('[data-testid="wb-modelconfig-window"]').fill("1000000");
    await page.locator('[data-testid="wb-modelconfig-max-output"]').fill("64000");
    await page.locator('[data-testid="wb-modelconfig-save"]').click();
    await page.waitForTimeout(1200);
  }

  const probeBtn = page.locator(`[data-testid="wb-modelconfig-test-${MODEL}"]`);
  out.probeButtonPresent = (await probeBtn.count()) > 0;
  if (out.probeButtonPresent) {
    await probeBtn.click();
    await page
      .locator(`[data-testid="wb-modelconfig-probe-result-${MODEL}"]`)
      .waitFor({ timeout: 90000 })
      .catch(() => undefined);
    out.probeResult = (await page
      .locator(`[data-testid="wb-modelconfig-probe-result-${MODEL}"]`)
      .textContent()) ?? "";
    out.probePassed = out.probeResult.includes("连通");
  }

  await shot(page, ".verify/newprovider.png");
} finally {
  if (child) await killTree(child);
}

const checks = [
  ["「新供应商」对话框能打开", out.dialogOpened === true],
  ["真拉到了模型清单（不是空/不是编的）", out.fetchedCount > 0],
  [`清单里有真模型 ${MODEL}`, out.fetchedHasRealModel === true],
  ["保存后对话框关闭", out.dialogClosed === true],
  ["config.json 里有这个供应商", out.providerSaved === true],
  ["格式存的是所选的那一种", out.providerProtocol === "openai-compatible"],
  ["模型列表存下来了", Array.isArray(out.providerModels) && out.providerModels.length > 0],
  ["密钥引用名生成了", typeof out.keyRef === "string" && out.keyRef.length > 0],
  ["新供应商出现在列表里", out.newProviderListed === true],
  ["「测试连通」按钮在", out.probeButtonPresent === true],
  ["测试连通真的通了（真发一轮）", out.probePassed === true],
];

let failed = 0;
for (const [name, ok] of checks) {
  if (!ok) failed += 1;
  process.stdout.write(`${ok ? "✓" : "✗"} ${name}\n`);
}
process.stdout.write("\n" + JSON.stringify(out, null, 2) + "\n");
process.stdout.write(`\n${failed === 0 ? "✓ 全部通过" : `✗ ${failed} 项未通过`}（${checks.length} 项）\n`);
process.exit(failed === 0 ? 0 : 1);
