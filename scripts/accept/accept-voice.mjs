import { chromium } from "playwright";
import { spawn } from "node:child_process";
import fs from "node:fs";

/**
 * 11.31 验收：设置里「声音选择」接成真功能。
 *
 * 原来五个设置行**全是死按钮**（`<button>` 没有 onClick）。这一行本地做得成，
 * 因为它接的是已经做真的「朗读」：
 *   选一个系统音色 → 朗读用它 → 记住选择。
 */
const DATA = "D:/DoubaoWorkClone/.verify/voice-data";
fs.rmSync(DATA, { recursive: true, force: true });
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
env.DSH_CANVAS_DATA_DIR = DATA;

const child = spawn(
  "D:/DoubaoWorkClone/node_modules/electron/dist/electron.exe",
  [".", "--remote-debugging-port=9730"],
  { cwd: "D:/DoubaoWorkClone", env, stdio: ["ignore", "ignore", "ignore"] },
);
await new Promise((r) => setTimeout(r, 8000));

const browser = await chromium.connectOverCDP("http://127.0.0.1:9730");
const pages = browser.contexts()[0].pages();
const page = pages.find((p) => !p.url().startsWith("devtools://")) ?? pages[0];
await page.waitForSelector('[data-testid="wb"]', { timeout: 20000 });
await page.waitForTimeout(1800);

const report = {};
try {
  await page.locator('[data-testid="wb-account"]').click();
  await page.waitForTimeout(1200);
  report.dialogOpened = await page.locator('[data-testid="wb-settings"]').count();

  // 那一行原来写死「温柔桃子」—— 不该再出现
  report.valueBefore = await page.locator('[data-testid="wb-set-voice-value"]').textContent();

  await page.locator('[data-testid="wb-set-声音选择"]').click();
  await page.waitForTimeout(1600);
  report.listOpened = await page.locator('[data-testid="wb-voice-list"]').count();
  report.voiceCount = await page.locator('[data-testid^="wb-voice-"]').count();
  report.voiceNames = await page.$$eval('[data-testid^="wb-voice-"]', (els) =>
    els.slice(0, 4).map((e) => e.textContent.trim()),
  );
  report.hasDefault = await page.locator('[data-testid="wb-voice-default"]').count();

  // 选第一个真实音色
  const first = await page.$$eval('[data-testid^="wb-voice-"]', (els) =>
    els.map((e) => e.getAttribute("data-testid")).filter((t) => t && t !== "wb-voice-default" && t !== "wb-voice-list"),
  );
  if (first.length > 0) {
    await page.locator(`[data-testid="${first[0]}"]`).click();
    await page.waitForTimeout(900);
    report.picked = first[0].replace("wb-voice-", "");
    report.valueAfterPick = await page.locator('[data-testid="wb-set-voice-value"]').textContent();
    report.persisted = await page.evaluate(() => localStorage.getItem("dsh-canvas.tts-voice"));
  }

  // 已禁用的三行：应带着原因，且点不动
  report.todoRows = await page.evaluate(() =>
    ["订阅与额度管理", "外观", "记忆"].map((label) => {
      const el = document.querySelector(`[data-testid="wb-set-${label}"]`);
      return { label, disabled: el?.disabled ?? null, title: el?.title ?? null };
    }),
  );

  /*
   * 「标准套餐」显示的是**真实在用的模型通道**，不是写死的「已开通」。
   * 先种一个设置再打开，看它有没有读出来。
   */
  await page.evaluate(() =>
    localStorage.setItem("dsh-canvas.chat-settings", JSON.stringify({ provider: "lunora", model: "gpt-image-2.5" })),
  );
  await page.locator(".wb-modal-close").click();
  await page.waitForTimeout(600);
  await page.locator('[data-testid="wb-account"]').click();
  await page.waitForTimeout(1000);
  report.planRow = await page.evaluate(() => {
    const el = document.querySelector('[data-testid="wb-set-标准套餐"]');
    return { text: el?.textContent?.trim() ?? null, title: el?.title ?? null };
  });
  report.planReflectsChannel = (report.planRow.text ?? "").includes("lunora");

  // 重开设置：选择应还在
  await page.locator(".wb-modal-close").click();
  await page.waitForTimeout(700);
  await page.locator('[data-testid="wb-account"]').click();
  await page.waitForTimeout(1000);
  report.valueAfterReopen = await page.locator('[data-testid="wb-set-voice-value"]').textContent();
} finally {
  console.log(JSON.stringify(report, null, 2));
  await browser.close().catch(() => undefined);
  child.kill();
}
