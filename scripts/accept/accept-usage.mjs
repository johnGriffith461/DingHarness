import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";
import { bootApp, connectWithRetry, freshDir, killTree, readStoreFile, shot, verdict, waitForPage } from "./harness.mjs";

/**
 * 验收：**真实用量到了步骤上，界面也如实说清了那个数是估的**（C5）。
 *
 * ⚠️ **这条会真调模型**（1 次），所以不进无模型批跑。
 *
 * ## 为什么这条必须有
 *
 * 原来工作台**把真实 usage 丢了**（`onEvent` 连 `done` 分支都没有），
 * 界面上那个「消耗 0.48」是**按字数估的**。而实机读数写明本体那个数是
 * **按额度计量**（`docs/HANDOFF.md:1695`）——本机没有额度体系，所以那个数算不出来。
 *
 * 于是 C5 的口径是两条一起：
 * ① **数据上接上真值**（`tasks.json` 里的步骤带 `usage`）；
 * ② **显示上如实**（hover 里说清这是估算、本机没有额度体系、真值是多少 tokens）。
 *
 * 这条把两条都验掉：读磁盘 + 读界面那句 title。
 */
const DATA = "D:/DoubaoWorkClone/.verify/usage-data";
if (!(await freshDir(DATA))) {
  console.error("✗ 数据目录 " + DATA + " 删不掉 —— 先手工关掉占着它的 Electron");
  process.exit(1);
}

const PORT = 9311;
const { child, ok, getLog } = await bootApp({ port: PORT, dataDir: DATA, timeoutMs: 30000 });
if (!ok) {
  console.error("[诊断] 应用输出尾部：\n" + (getLog() || "(空)").slice(-1200));
  await killTree(child);
  process.exit(1);
}

const out = {};
try {
  const b = await connectWithRetry(chromium, `http://127.0.0.1:${PORT}`);
  const page = await waitForPage(b);
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
