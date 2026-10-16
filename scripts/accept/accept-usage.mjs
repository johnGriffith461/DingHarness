import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";
import { bootApp, connectWithRetry, freshDir, killTree, readStoreFile, shot, verdict, waitForPage } from "./harness.mjs";

/**
 * 验收：**真实用量到了步骤上，界面也如实说清了那个数是估的**（C5）。
 *
 * ⚠️ 它原来写着「会真调模型（1 次），所以不进无模型批跑」——**那句已经过期**（2026-10-16）：
 * 它要的其实只是一次**文本轮带 usage**，而批跑的假通道在 SSE 里本来就带 usage 帧，所以它**已经收进批跑**
 * （`verify-acceptances.mjs` 的 CASES）。判据一字未改：步骤上有 provider 给的 tokens +
 * 界面那句 hover 如实说清那个数是估的。
 *
 * ## 为什么这条必须有
 *
 * 原来工作台**把真实 usage 丢了**（`onEvent` 连 `done` 分支都没有），
 * 界面上那个「消耗 0.48」是**按字数估的**。而实机读数写明本体那个数是
 * **按额度计量**（`docs/HANDOFF.md:1695`）——本机没有额度体系，所以那个数算不出来。
 * ⚠️（该依据未入库、本机也找不到 —— 决策链断在这里，无法复核；以本文件里的断言与实现为准）
 *
 * 于是 C5 的口径是两条一起：
 * ① **数据上接上真值**（`tasks.json` 里的步骤带 `usage`）；
 * ② **显示上如实**（hover 里说清这是估算、本机没有额度体系、真值是多少 tokens）。
 *
 * 这条把两条都验掉：读磁盘 + 读界面那句 title。
 */
const DATA = ".verify/usage-data";
if (!(await freshDir(DATA))) {
  console.error("✗ 数据目录 " + DATA + " 删不掉 —— 先手工关掉占着它的 Electron");
  process.exit(1);
}

/* ⚠️ 2026-10-16（审计 G06/G07）：bootApp 会换端口重试 —— 下面用的是它返回的实际端口，不再假设给哪个就用哪个 */
let PORT = 9311;
const booted = await bootApp({ port: PORT, dataDir: DATA, timeoutMs: 30000 });
const { child, ok, getLog } = booted;
/* 用实际端口（bootApp 换过端口时它与首选不同） */
PORT = booted.port;
if (!ok) {
  console.error("[诊断] 应用输出尾部：\n" + (getLog() || "(空)").slice(-1200));
  await killTree(child);
  process.exit(1);
}

const out = {};
try {
  const b = await connectWithRetry(chromium, `http://127.0.0.1:${PORT}`);
  const page = await waitForPage(b);

  if (!page) throw new Error("应用起了但一个页面都没建（NO_PAGE_HINT）——多半是 .cjs 标记那一步没跑");
  await page.waitForSelector('[data-testid="wb"]', { timeout: 20000 });
  await page.waitForTimeout(1200);

  await page.locator('[data-testid="wb-nav-home"]').click();
  await page.waitForTimeout(500);
  await page.locator('[data-testid="wb-composer-input"]').fill("只回答两个字：收到");
  await page.locator('[data-testid="wb-send"]').click();

  const deadline = Date.now() + 120000;
  while (Date.now() < deadline && (await page.locator(".wb-assistant-text").count()) === 0) {
    await page.waitForTimeout(1500);
  }
  // 有提问卡就先答掉（正常不该出现）
  for (let i = 0; i < 3; i += 1) {
    if ((await page.locator('[data-testid="wb-question-card"]').count()) === 0) break;
    await page.locator('[data-testid="wb-option-0"]').first().click();
    await page.waitForTimeout(2500);
  }
  await page.waitForTimeout(3000);

  /* ① 界面：那个数在，且 hover 里是如实说明 */
  out.costText = await page.evaluate(
    () => document.querySelector(".wb-cost")?.textContent?.replace(/\s+/g, " ").trim() ?? "",
  );
  out.costTitle = await page.evaluate(() => document.querySelector(".wb-cost")?.getAttribute("title") ?? "");
  out.titleSaysEstimate = out.costTitle.includes("估算");
  out.titleSaysNoQuota = out.costTitle.includes("没有额度体系");
  out.titleHasRealTokens = /真实用量：\d+ 输入 \/ \d+ 输出 tokens/.test(out.costTitle);
  out.shot = await shot(page, "usage.png");

  /* ② 磁盘：那一步上真带着 main 给的 usage */
  const tasksFile = path.join(DATA, "tasks.json");
  out.tasksFileExists = fs.existsSync(tasksFile);
  const tasks = out.tasksFileExists ? readStoreFile(tasksFile) : [];
  const assistant = (Array.isArray(tasks) ? tasks : [])
    .flatMap((t) => t?.steps ?? [])
    .filter((s) => s?.role === "assistant" && s?.usage);
  out.stepsWithUsage = assistant.length;
  out.sampleUsage = assistant[0]?.usage ?? null;
  out.costOnStep = assistant[0]?.cost ?? null;
  out.inputIsPositive = (out.sampleUsage?.inputTokens ?? 0) > 0;
  out.outputIsPositive = (out.sampleUsage?.outputTokens ?? 0) > 0;

  await b.close();
} catch (e) {
  out.error = String(e).slice(0, 300);
} finally {
  console.log(JSON.stringify(out, null, 2));
  await killTree(child);
}

const bad = [];
if (out.error) bad.push("异常: " + out.error);
if (!out.costText.includes("消耗")) bad.push("界面上那个「消耗」不见了（形态被改坏了）");
if (!out.titleSaysEstimate) bad.push("hover 里没说这是**估算**（那就在假装它是额度真值）");
if (!out.titleSaysNoQuota) bad.push("hover 里没说清「本机没有额度体系」（本体的额度与本机不通用）");
if (!out.titleHasRealTokens) bad.push(`hover 里没有真实用量：${out.costTitle.slice(0, 80)}`);
if (!out.stepsWithUsage) bad.push("⭐ 磁盘上的步骤没有 usage（真实用量还是被丢了）");
if (!out.inputIsPositive || !out.outputIsPositive) bad.push(`usage 不像是真的：${JSON.stringify(out.sampleUsage)}`);
if (typeof out.costOnStep !== "number") bad.push("步骤上没有那个估算数（界面就显示不出来了）");
verdict(bad, "真实用量成立：步骤上带着 provider 的 tokens，界面如实说明那个数是估的、本机没有额度体系");
