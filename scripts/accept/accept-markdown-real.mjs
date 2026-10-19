import { chromium } from "playwright";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { NO_PAGE_HINT, bootApp, connectWithRetry, freshDir, killTree, shot, waitForPage } from "./harness.mjs";

/**
 * 验收 T-03：**真 provider** 让模型用 Markdown 回答，界面必须真的渲染出来。
 *
 * ## 为什么真跑
 *
 * 单测证明"组件能把 `**x**` 变成 `<strong>`"；但它证明不了"模型吐出来的那段文本
 * 真的走到了这个组件"（上一轮的教训：`memoryPromptBlock` 写了没人调、`askCard` 有单测没接线）。
 * 所以这里真发一轮、真读 DOM。
 *
 * ## 判据
 *
 * ① 助手气泡里出现 `<strong>` / `<ul>` / `<code>` / `<pre>` 中至少三类；
 * ② 原始 HTML 用例：让模型复述一个 `<img onerror>` 字符串，DOM 里**不能**出现 img 标签；
 * ③ 用户自己的消息仍是纯文本（把 `**不该加粗**` 发给它，用户气泡里不能有 `<strong>`）。
 *
 * 用法：node scripts/accept/accept-markdown-real.mjs --yes-spend
 */
const MODEL = process.env.ACCEPT_MODEL ?? "deepseek-v4.1-flash-1017";
const PROVIDER = process.env.ACCEPT_PROVIDER ?? "tokenrhythm";
const MAX_TOKENS = Number(process.env.ACCEPT_MAX_TOKENS ?? 120_000);
const LOG = path.join(process.cwd(), ".verify", "accept-markdown-real.log");

if (!process.argv.includes("--yes-spend")) {
  process.stdout.write(`计划：真模型 ${PROVIDER}/${MODEL} 回一段 Markdown，验证界面真的渲染\n  预算：≤ ¥2（按 token 闸 ${MAX_TOKENS}）\n`);
  process.exit(2);
}
if (process.env.DING_NO_REAL_MODEL?.trim() || process.env.DSH_NO_REAL_MODEL?.trim()) {
  process.stderr.write("零出网闸开着：先取消再跑\n");
  process.exit(2);
}
const realCreds = path.join(os.homedir(), ".ding", ".credentials.yaml");
if (!fs.existsSync(realCreds)) {
  process.stderr.write(`没有真实凭据文件：${realCreds}\n`);
  process.exit(2);
}

const DATA = ".verify/markdown-real-data";
if (!(await freshDir(DATA))) {
  console.error("✗ 数据目录删不掉");
  process.exit(1);
}
fs.mkdirSync(DATA, { recursive: true });
fs.writeFileSync(
  path.join(DATA, "models.json"),
  JSON.stringify({
    version: 1,
    rules: [
      {
        type: "exact",
        providerId: PROVIDER,
        modelId: MODEL,
        manual: true,
        config: { properties: { contextWindow: 1_000_000, supportsToolCall: true, inputFormat: { supportsText: true } } },
      },
    ],
  }),
  "utf8",
);
fs.writeFileSync(
  path.join(DATA, "settings.json"),
  JSON.stringify({ __schema: 1, data: { pinnedModel: `${PROVIDER}/${MODEL}` } }),
  "utf8",
);

const PORT = 9441;
const out = {};
let child = null;

try {
  delete process.env.DSH_NO_REAL_MODEL;
  delete process.env.DING_NO_REAL_MODEL;
  delete process.env.STRATA_BASE_URL;
  delete process.env.STRATA_API_KEY;
  process.env.DSH_CREDENTIALS_FILE = realCreds;

  const booted = await bootApp({ port: PORT, dataDir: DATA, timeoutMs: 40000 });
  child = booted.child;
  if (!booted.ok) {
    console.error("[诊断] " + (booted.getLog() || "").slice(-1200));
    process.exit(1);
  }
  const browser = await connectWithRetry(chromium, `http://127.0.0.1:${PORT}`);
  const page = await waitForPage(browser);
  if (!page) throw new Error(NO_PAGE_HINT);
  await page.waitForSelector('[data-testid="wb"]', { timeout: 20000 });
  await page.waitForTimeout(1200);

  await page.evaluate(() => localStorage.setItem("dsh-canvas.confirm-mode", "全部允许"));
  const input = page.locator('[data-testid="wb-composer-input"]');
  await input.click();
  await input.fill(
    [
      "请用 Markdown 原样回答下面四项，不要省略，也不要额外解释：",
      "1) 一行加粗：**重要结论**",
      "2) 一个无序列表，两项：- 第一项 / - 第二项",
      "3) 一段行内代码：`pnpm test`",
      "4) 一个 TypeScript 代码块，内容是 const x = 1;",
      "另外，请把这段文字原样复述一次（不要渲染）：<img src=x onerror=alert(1)>",
      "还有：请在正文里保留 **不该加粗** 这几个字（我会检查用户消息不被当 Markdown 解析）。",
    ].join("\n"),
  );
  /* 用户消息里也带 markdown 记号（判据③） */
  await page.locator('[data-testid="wb-send"]').click();

  /*
   * ⚠️ 等**落定的那一步**出现，而不是等"停止键消失" ——
   * 停止键在流开始之前本来就不存在，那个条件会立刻为真（实测踩到：
   * 抓到的是流式草稿，草稿里还是纯文本，于是"Markdown 没渲染"是假红）。
   */
  await page.locator('[data-testid="wb-task"] .wb-assistant:not(.wb-draft) [data-testid="wb-md"]').first().waitFor({ timeout: 180_000 });
  await page.waitForTimeout(1200);

  out.assistantCount = await page.locator('[data-testid="wb-task"] .wb-assistant:not(.wb-draft)').count();
  out.markdownBlocks = await page.locator('[data-testid="wb-md"]').count();
  out.mdByClass = await page.locator('.wb-md').count();
  out.assistantHtml = (await page.locator('[data-testid="wb-task"] .wb-assistant:not(.wb-draft) [data-testid="wb-md"]').first().innerHTML().catch(() => "")).slice(0, 600);
  out.strong = await page.locator('[data-testid="wb-md"] strong').count();
  out.ul = await page.locator('[data-testid="wb-md"] ul').count();
  out.inlineCode = await page.locator('[data-testid="wb-md"] code').count();
  out.pre = await page.locator('[data-testid="wb-md"] pre').count();
  out.img = await page.locator('[data-testid="wb-md"] img').count();
  out.userBubbleStrong = await page.locator('.wb-bubble-user strong').count();
  out.userBubbleText = (await page.locator('.wb-bubble-user').first().textContent().catch(() => "")) ?? "";
  out.rawHtmlVisibleAsText = (await page.locator('[data-testid="wb-md"]').innerText()).includes("onerror");

  /* 用量 */
  out.usage = await page.evaluate(async () => {
    const list = await window.shell.session.list("all");
    const sid = list.map((s) => s.sessionId).find((id) => String(id).startsWith("task-"));
    if (!sid) return null;
    const got = await window.shell.session.load(sid);
    const done = (got?.records ?? []).filter((r) => r.type === "done" && r.usage);
    return done[done.length - 1]?.usage ?? null;
  });
  out.tokens = Number(out.usage?.inputTokens ?? 0) + Number(out.usage?.outputTokens ?? 0);

  await shot(page, ".verify/markdown-real.png");
} catch (error) {
  out.error = error instanceof Error ? error.message : String(error);
} finally {
  await killTree(child);
  fs.mkdirSync(path.dirname(LOG), { recursive: true });
  fs.writeFileSync(LOG, [new Date().toISOString(), `model=${PROVIDER}/${MODEL}`, JSON.stringify(out, null, 2)].join("\n"), "utf8");
}

const kinds = [out.strong > 0, out.ul > 0, out.inlineCode > 0, out.pre > 0].filter(Boolean).length;
const checks = [
  ["助手回答真的走了 Markdown 组件", out.markdownBlocks > 0],
  [`至少三类 Markdown 结构渲染出来了（现在 ${kinds}/4：strong ${out.strong} / ul ${out.ul} / code ${out.inlineCode} / pre ${out.pre}）`, kinds >= 3],
  ["原始 HTML 没有变成 img 标签（XSS 底线）", out.img === 0],
  ["原始 HTML 作为文本可见（onerror 字样在）", out.rawHtmlVisibleAsText === true],
  ["用户消息保持纯文本（没有 strong）", out.userBubbleStrong === 0],
  ["用户消息里的星号原样保留", out.userBubbleText.includes("**不该加粗**")],
  [`token 在预算内（${out.tokens ?? 0} ≤ ${MAX_TOKENS}）`, (out.tokens ?? 0) <= MAX_TOKENS],
];

if (out.error) process.stdout.write(`\n异常：${out.error}\n`);
let failed = 0;
for (const [name, ok] of checks) {
  if (!ok) failed += 1;
  process.stdout.write(`${ok ? "✓" : "✗"} ${name}\n`);
}
process.stdout.write("\n" + JSON.stringify(out, null, 2) + "\n");
process.stdout.write(`\n${failed === 0 ? "✓ 全部通过" : `✗ ${failed} 项未通过`}（${checks.length} 项）\n日志：${LOG}\n`);
process.exit(failed === 0 ? 0 : 1);
