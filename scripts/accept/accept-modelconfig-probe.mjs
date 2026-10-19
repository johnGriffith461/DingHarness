import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";
import { NO_PAGE_HINT, bootApp, connectWithRetry, freshDir, killTree, shot, waitForPage } from "./harness.mjs";

/**
 * 验收：**「测试连通」按钮真的打真 provider**（T0）。
 *
 * ## 为什么这条必须花钱
 *
 * 这个按钮存在的唯一理由就是"告诉我这个模型现在能不能用"。
 * 假服务器能让它显示绿灯，而那正是**它最不该错的地方** ——
 * 用户按下去是为了排掉"密钥错 / 通道拒绝 / 模型名拼错"，
 * 假服务器这三种一个都验不出来。
 *
 * 所以：真应用 + 真 key + 真模型，点一次按钮，看它报什么。
 *
 * ## 判据
 *
 * 1. 先在表单里填一个**不存在的模型名** → 按钮必须报"不通"（说明它真的在发请求，不是恒绿）；
 * 2. 再填真实模型 → 按钮必须报"连通"并给出墙钟与回复内容；
 * 3. 两次结果都进了界面（不是只在 console 里）。
 *
 * 需要 `--yes-spend`；零出网闸开着时拒绝运行。
 */
const DATA = ".verify/modelconfig-probe-data";
const PROVIDER = process.env.ACCEPT_PROVIDER ?? "tokenrhythm";
const MODEL = process.env.ACCEPT_MODEL ?? "deepseek-v4.1-flash-1017";
const PORT = 9373;

if (!process.argv.includes("--yes-spend")) {
  process.stdout.write(
    `计划：真应用里点两次「测试连通」（${PROVIDER}）\n` +
      `  ① 假模型名 → 必须报不通（证明它真的在发请求）\n` +
      `  ② 真模型 ${MODEL} → 必须报连通\n` +
      `  两次都是最小请求（几分钱以内）。确认后加 --yes-spend\n`,
  );
  process.exit(2);
}
if (process.env.DING_NO_REAL_MODEL?.trim() || process.env.DSH_NO_REAL_MODEL?.trim()) {
  process.stderr.write("零出网闸开着：这条要真调 provider，先取消再跑\n");
  process.exit(2);
}

if (!(await freshDir(DATA))) {
  console.error("✗ 数据目录 " + DATA + " 删不掉 —— 先手工关掉占着它的 Electron");
  process.exit(1);
}
const out = {};
let child = null;

const openModelSettings = async (page) => {
  await page.locator('[data-testid="wb-account"]').click();
  await page.waitForTimeout(600);
  await page.locator('[data-testid="wb-acct-settings"]').click();
  await page.waitForTimeout(800);
  const modelsTab = page.locator('[data-testid="wb-set-模型"]');
  if (await modelsTab.count()) {
    await modelsTab.click();
    await page.waitForTimeout(700);
  }
};

/* 用真 key：把用户已有的凭据目录接进来（只读，不复制、不打印） */
const credentialEnv = (() => {
  const home = process.env.USERPROFILE ?? process.env.HOME ?? "";
  const ding = path.join(home, ".ding", ".credentials.yaml");
  const dsh = path.join(home, ".dsh", ".credentials.yaml");
  if (fs.existsSync(ding)) return { DING_CREDENTIALS_FILE: ding };
  if (fs.existsSync(dsh)) return { DING_CREDENTIALS_FILE: dsh };
  return {};
})();
if (!Object.keys(credentialEnv).length) {
  console.error("✗ 本机找不到凭据文件（~/.ding 或 ~/.dsh 都没有）—— 这条要真 key");
  process.exit(2);
}

try {
  const first = await bootApp({ port: PORT, dataDir: DATA, timeoutMs: 30000, extraEnv: credentialEnv });
  child = first.child;
  if (!first.ok) throw new Error("启动失败：" + (first.getLog() || "").slice(-800));
  const browser = await connectWithRetry(chromium, `http://127.0.0.1:${PORT}`);
  const page = await waitForPage(browser);
  if (!page) throw new Error(NO_PAGE_HINT);
  await page.waitForSelector('[data-testid="wb"]', { timeout: 20000 });
  await page.waitForTimeout(1500);
  await openModelSettings(page);

  /* 打开表单，填一个**不存在的**模型名，点测试 */
  await page.locator('[data-testid="wb-modelset-add"]').click();
  await page.waitForTimeout(600);
  await page.locator('[data-testid="wb-modelconfig-id"]').fill("no-such-model-xyz-9999");
  await page.locator('[data-testid="wb-modelconfig-window"]').fill("200000");
  await page.locator('[data-testid="wb-modelconfig-test"]').click();

  const result = page.locator('[data-testid="wb-modelconfig-test-result"]');
  await result.waitFor({ timeout: 60000 });
  out.fakeModelText = (await result.textContent()) ?? "";
  out.fakeModelRejected = out.fakeModelText.includes("✗");

  /* 换成真模型，再点一次 */
  await page.locator('[data-testid="wb-modelconfig-id"]').fill(MODEL);
  await page.locator('[data-testid="wb-modelconfig-window"]').fill("1000000");
  await page.locator('[data-testid="wb-modelconfig-max-output"]').fill("64000");
  await page.locator('[data-testid="wb-modelconfig-output-map"]').fill('{"max_tokens": "{{maxOutputTokens}}"}');
  await page.waitForTimeout(600);
  await page.locator('[data-testid="wb-modelconfig-test"]').click();

  /* 等结果从"上一次的失败"变成"这一次的成功" */
  await page.waitForFunction(
    () => {
      const node = document.querySelector('[data-testid="wb-modelconfig-test-result"]');
      return Boolean(node && node.textContent && node.textContent.includes("✓"));
    },
    { timeout: 90000 },
  );
  out.realModelText = (await result.textContent()) ?? "";
  out.realModelPassed = out.realModelText.includes("✓") && out.realModelText.includes("连通");
  await shot(page, ".verify/modelconfig-probe.png");
} finally {
  if (child) await killTree(child);
}

const checks = [
  ["假模型名被真发请求验掉了（报不通，不是恒绿）", out.fakeModelRejected === true],
  ["真模型点出来是连通", out.realModelPassed === true],
  ["结果里给了墙钟（说明真跑了一轮）", /[0-9]+ms/.test(out.realModelText ?? "")],
];

let failed = 0;
for (const [name, ok] of checks) {
  if (!ok) failed += 1;
  process.stdout.write(`${ok ? "✓" : "✗"} ${name}\n`);
}
process.stdout.write("\n" + JSON.stringify(out, null, 2) + "\n");
process.stdout.write(`\n${failed === 0 ? "✓ 全部通过" : `✗ ${failed} 项未通过`}（真 provider ${PROVIDER}/${MODEL}）\n`);
process.exit(failed === 0 ? 0 : 1);
