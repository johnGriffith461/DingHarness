import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";
import {
  NO_PAGE_HINT,
  bootApp,
  connectWithRetry,
  freshDir,
  killTree,
  shot,
  waitForPage,
} from "./harness.mjs";

/**
 * F-03（2026-10-20）：**无通道时给诊断与可点的下一步**。
 *
 * 旧行为只有一句"还没有可用的 AI 通道（先确认至少一个 provider 配好了密钥）"：
 * 没有下一步，而且"没 key"与"有 key 没模型"说的是同一句。
 *
 * 这里在真应用里造两种**能造出来**的状态（第三种 `no_model` 在
 * `src/ai/route.test.ts` 用同一份 `diagnoseRoute` 钉住 —— 真机上无法构造
 * "provider 有 key 但 models 为空"：自定义 provider 的写入校验明确拒绝空清单）：
 * 1. `no_key`：空凭据 → 首屏向导点「稍后再说」→ 首页横幅「还没有配置任何 provider 的密钥」+「去填 key」；
 * 2. `pinned_dead`：有 deepseek key、但钉住 anthropic → 首页横幅「钉住的通道现在不可用」+「换一个模型」。
 *
 * 两次都点横幅上的按钮，断言设置直接落在**模型页**（那里既有 key 也有模型清单）。
 */

const ROOT = path.resolve(".verify", "route-diagnosis");
const PORT = 9383;

async function runState(name, { dataDir, creds, credsBody = "refs:\n", settings }) {
  if (!(await freshDir(dataDir))) throw new Error(`数据目录 ${dataDir} 删不掉`);
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(creds, credsBody, "utf8");
  if (settings) fs.writeFileSync(path.join(dataDir, "settings.json"), JSON.stringify(settings, null, 2), "utf8");

  const out = { name };
  let child = null;
  let browser = null;
  try {
    const booted = await bootApp({
      port: PORT,
      dataDir,
      timeoutMs: 30000,
      extraEnv: { DING_CREDENTIALS_FILE: creds },
    });
    child = booted.child;
    if (!booted.ok) throw new Error("应用没起来：" + (booted.getLog() || "").slice(-800));
    browser = await connectWithRetry(chromium, `http://127.0.0.1:${PORT}`);
    const page = await waitForPage(browser);
    if (!page) throw new Error(NO_PAGE_HINT);
    await page.waitForSelector('[data-testid="wb"]', { timeout: 20000 });
    await page.waitForTimeout(1200);

    /* 没有 key 时首跑向导会挡住首页；点「稍后再说」走到首页（F-01 的口子） */
    if ((await page.locator('[data-testid="wb-firstrun"]').count()) === 1) {
      await page.locator('[data-testid="wb-firstrun-skip"]').click();
      await page.waitForTimeout(900);
    }

    const banner = page.locator('[data-testid="wb-home-route-fix"]');
    await banner.waitFor({ timeout: 10000 });
    out.message = (await page.locator('[data-testid="wb-home-route-fix-message"]').innerText()).trim();
    out.action = (await page.locator('[data-testid="wb-home-route-fix-action"]').innerText()).trim();
    await shot(page, `.verify/route-diagnosis-${name}.png`);

    await page.locator('[data-testid="wb-home-route-fix-action"]').click();
    await page.waitForTimeout(800);
    out.settingsModelsOpen = (await page.locator('[data-testid="wb-setpage-models"]').count()) === 1;
    await shot(page, `.verify/route-diagnosis-${name}-models.png`);
  } finally {
    if (browser) await browser.close();
    await killTree(child);
  }
  return out;
}

let outKey;
let outDead;
try {
  fs.mkdirSync(ROOT, { recursive: true });
  outKey = await runState("no-key", {
    dataDir: path.join(ROOT, "no-key-data"),
    creds: path.join(ROOT, "no-key-credentials.yaml"),
  });
  outDead = await runState("pinned-dead", {
    dataDir: path.join(ROOT, "pinned-dead-data"),
    creds: path.join(ROOT, "one-key-credentials.yaml"),
    /* 只给 deepseek 一把假 key（不会发请求，只用于"这家可用"的判定） */
    credsBody: "refs:\n  DEEPSEEK_API_KEY: probe-not-used\n",
    settings: { pinnedModel: "anthropic/claude-sonnet-4-5" },
  });
} catch (error) {
  console.error(`\n异常：${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}

const checks = [
  ['no_key：诊断说"还没有配置任何 provider 的密钥"', outKey.message.includes("密钥")],
  ['no_key：按钮写「去填 key」', outKey.action.includes("去填 key")],
  ["no_key：点按钮直接到设置·模型页", outKey.settingsModelsOpen === true],
  ['pinned_dead：诊断说"钉住的通道现在不可用"', outDead.message.includes("钉住的通道现在不可用")],
  ['pinned_dead：按钮写「换一个模型」', outDead.action.includes("换一个模型")],
  ["pinned_dead：点按钮直接到设置·模型页", outDead.settingsModelsOpen === true],
];

let failed = 0;
for (const [name, ok] of checks) {
  if (!ok) failed += 1;
  process.stdout.write(`${ok ? "✓" : "✗"} ${name}\n`);
}
process.stdout.write("\n" + JSON.stringify({ noKey: outKey, pinnedDead: outDead }, null, 2) + "\n");
process.stdout.write(`\n${failed === 0 ? "✓ 全部通过" : `✗ ${failed} 项未通过`}（${checks.length} 项：无通道诊断与下一步）\n`);
process.exit(failed === 0 ? 0 : 1);
