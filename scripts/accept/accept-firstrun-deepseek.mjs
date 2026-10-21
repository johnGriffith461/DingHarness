// 出厂只有 DeepSeek 一家（2026-10-21 主人拍板）—— 常驻回归。
//
// 原话：「软件不要给它去内置那些渠道了吧 就留一个 Deepseek 渠道就行，
// 然后 Deepseek 的渠道信息都给填好了，让用户只用输入 key 就行」。
//
// 判据（全是行为，且**在用户态**跑：关掉验收通道）：
//   ① 首跑向导落在「② 填 key」—— 只有一家可选，不该再让用户在下拉里点一次；
//   ② 第 1 步显示"已选：DeepSeek 官方（地址与模型已预填）"；
//   ③ 填 key 那一步写明地址与模型名（用户只需要一条 key）；
//   ④ ⭐ 全程**看不到**验收通道（`strata` / "本地测试通道"）—— 主人当场质疑过这个；
//   ⑤ 设置·模型页左列只有一家（出厂没替用户列一堆没用过的中转站）。
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";
import {
  bootApp,
  connectWithRetry,
  failOnMarks,
  freshDir,
  killLeftovers,
  killTree,
  pickPort,
  sleep,
  verdict,
  waitForPage,
} from "./harness.mjs";

failOnMarks();

const bad = [];
const note = (m) => console.log("   " + m);

const DATA = ".verify/accept-firstrun-deepseek-data";
const CREDS = ".verify/accept-firstrun-deepseek-creds";
if (!(await freshDir(DATA))) {
  console.error("✗ 数据目录 " + DATA + " 删不掉 —— 先手工关掉占着它的 Electron");
  process.exit(1);
}
await freshDir(CREDS);
fs.mkdirSync(CREDS, { recursive: true });
const CRED_FILE = path.join(CREDS, "credentials.yaml");
/* 空凭据：这是个"什么都没配过"的新用户 */
fs.writeFileSync(CRED_FILE, "refs:\n", "utf8");

const port = await pickPort([9932]);
await killLeftovers();
const booted = await bootApp({
  port,
  dataDir: DATA,
  timeoutMs: 40_000,
  extraEnv: {
    /*
     * ⭐ **用户态**：关掉验收通道。harness 默认给 `1`（让 strata 出现在验收里），
     * 这条要验的正是"出厂只有 DeepSeek"，所以显式覆盖成 0。
     */
    DING_ACCEPT_PROVIDERS: "0",
    DING_CREDENTIALS_FILE: CRED_FILE,
    STRATA_API_KEY: "",
    STRATA_BASE_URL: "",
  },
});
if (!booted.ok) {
  console.error("✗ 应用没起来：" + (booted.getLog() || "").slice(-600));
  process.exit(1);
}

let browser;
try {
  browser = await connectWithRetry(chromium, `http://127.0.0.1:${booted.port}`);
  const page = await waitForPage(browser, 20000, { keepFirstRun: true });
  await page.waitForSelector('[data-testid="wb-firstrun"]', { timeout: 20000 });
  await sleep(1500);

  const steps = page.locator(".wb-firstrun-steps > li");
  const active = await steps.evaluateAll((els) => els.map((e) => e.getAttribute("data-active")));
  /* ① 落在第 2 步（填 key） */
  if (active[1] !== "true") bad.push(`新用户第一眼没落在「填 key」（active=${active.join(",")}）`);
  else note("落点：② 填 key ✓");

  /* ② 第 1 步已选 + 预填 */
  const picked = ((await page.locator('[data-testid="wb-firstrun-picked"]').textContent().catch(() => "")) ?? "").replace(/\s+/g, " ");
  if (!/DeepSeek/.test(picked)) bad.push(`第 1 步没显示已选 DeepSeek（实际：${picked || "(空)"}）`);
  else if (!/预填/.test(picked)) bad.push(`第 1 步没说明"地址与模型已预填"（实际：${picked}）`);
  else note(`第 1 步：${picked}`);

  /* ③ 填 key 那一步写明地址与模型 */
  const hint = ((await page.locator('[data-testid="wb-firstrun-prefilled"]').textContent().catch(() => "")) ?? "").replace(/\s+/g, " ");
  if (!/api\.deepseek\.com/.test(hint)) bad.push(`填 key 那步没写明接口地址（实际：${hint || "(空)"}）`);
  if (!/deepseek-chat/.test(hint)) bad.push(`填 key 那步没写明模型名（实际：${hint || "(空)"}）`);
  if (hint) note(`预填：${hint.slice(0, 110)}…`);

  /* ④ 全程看不到验收通道 */
  const bodyText = ((await page.locator('[data-testid="wb-firstrun"]').innerText()) ?? "").replace(/\s+/g, " ");
  for (const banned of ["strata", "本地测试通道", "本地 abliterated", "accept-fake"]) {
    if (bodyText.includes(banned)) bad.push(`⭐ 用户态首跑向导里出现了「${banned}」（假通道漏到用户面前了）`);
  }

  /* ⑤ 设置·模型页左列只有一家 */
  await page.locator('[data-testid="wb-firstrun-skip"]').click();
  await sleep(700);
  await page.locator('[data-testid="wb-account"]').click();
  await sleep(600);
  await page.locator('[data-testid="wb-acct-settings"]').click();
  await sleep(900);
  await page.locator('[data-testid="wb-set-模型"]').click();
  await sleep(1200);
  const rows = await page.locator('[data-testid^="wb-modelset-provider-"]').evaluateAll((els) =>
    els.map((e) => (e.getAttribute("data-testid") ?? "").replace("wb-modelset-provider-", "")),
  );
  if (rows.length !== 1 || rows[0] !== "deepseek") bad.push(`出厂左列应只有 deepseek，实际是 [${rows.join(", ")}]`);
  else note("设置·模型页左列：只有 deepseek ✓");
  const listText = ((await page.locator('[data-testid="wb-modelset-list"]').innerText()) ?? "").replace(/\s+/g, " ");
  if (/本地测试通道|strata/.test(listText)) bad.push("设置左列里出现了验收通道");
  await page.screenshot({ path: ".verify/mset-11-only-deepseek.png" });
  note("截图：.verify/mset-11-only-deepseek.png");
} catch (e) {
  bad.push("异常: " + String(e).slice(0, 300));
} finally {
  await browser?.close().catch(() => undefined);
  await killTree(booted.child);
  await killLeftovers();
}

verdict(bad, "出厂只有 DeepSeek：向导直接到填 key / 地址与模型已预填 / 用户态看不到任何验收通道 / 设置左列只有一家");
