import { chromium } from "playwright";
import { spawn } from "node:child_process";
import fs from "node:fs";
import { connectWithRetry, pickPort, verdict } from "./harness.mjs";

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

/* 这台机器的回环端口会随机连不上（见 harness.pickPort）→ 起之前先挑一个能用的。 */
const __port = await pickPort([12730]);
const child = spawn(
  "D:/DoubaoWorkClone/node_modules/electron/dist/electron.exe",
  [".", "--remote-debugging-port=" + __port],
  { cwd: "D:/DoubaoWorkClone", env, stdio: ["ignore", "ignore", "ignore"] },
);
await new Promise((r) => setTimeout(r, 8000));

const browser = await connectWithRetry(chromium, "http://127.0.0.1:" + __port);
const pages = browser.contexts()[0].pages();
const page = pages.find((p) => !p.url().startsWith("devtools://")) ?? pages[0];
await page.waitForSelector('[data-testid="wb"]', { timeout: 20000 });
await page.waitForTimeout(1800);

const report = {};
try {
  /*
   * ⚠️ 导航在 2026-10-14 改对：`wb-account` 现在弹的是**账号菜单**（本体形态），
   * 「设置」是其中一项。原来直接点 `wb-account` 就去找设置行，于是等不到、
   * 抛超时 —— 这正是它长期 exit 1（无判定行）的原因。
   */
  await page.locator('[data-testid="wb-account"]').click();
  await page.waitForTimeout(600);
  await page.locator('[data-testid="wb-acct-settings"]').click();
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
  /*
   * 只查**真正还禁用**的那一行。原来这里还查「外观」（早就挪进账号菜单的子菜单了）
   * 和「记忆」（现在是真功能：点开是记忆面板）—— 拿旧清单去断言现状，
   * 红的是断言不是产品。
   */
  report.todoRows = await page.evaluate(() =>
    ["订阅与额度管理"].map((label) => {
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
  /* 同一件事：账号按钮开的是**菜单**，设置在其中一项（我第一版漏改了中间这一处）。 */
  await page.locator('[data-testid="wb-account"]').click();
  await page.waitForTimeout(500);
  await page.locator('[data-testid="wb-acct-settings"]').click();
  await page.waitForTimeout(1000);
  report.planRow = await page.evaluate(() => {
    const el = document.querySelector('[data-testid="wb-set-标准套餐"]');
    return { text: el?.textContent?.trim() ?? null, title: el?.title ?? null };
  });
  report.planReflectsChannel = (report.planRow.text ?? "").includes("lunora");

  // 重开设置：选择应还在（同样走"账号按钮 → 菜单 → 设置"）
  await page.locator(".wb-modal-close").click();
  await page.waitForTimeout(700);
  await page.locator('[data-testid="wb-account"]').click();
  await page.waitForTimeout(500);
  await page.locator('[data-testid="wb-acct-settings"]').click();
  await page.waitForTimeout(1000);
  report.valueAfterReopen = await page.locator('[data-testid="wb-set-voice-value"]').textContent();
} catch (error) {
  /*
   * 原来这里**没有 catch** —— 中途某一步等不到元素就直接抛出去：
   * 报告打了、判定没有、退出码 1，读的人只看到一句"exit 1（无判定行）"，
   * 既不知道坏在哪、也不知道是不是脚本自己过期了。现在收成一条判词。
   */
  report.error = String(error).split(String.fromCharCode(10))[0];
} finally {
  console.log(JSON.stringify(report, null, 2));

  /*
   * ── 判定（2026-10-14 补）────────────────────────────────────────────
   *
   * 原来这条**跑到一半抛异常**（账号菜单改版之后导航就死了），既没有判定、
   * 也不打印错误摘要，在清单里只留了句"exit 1（无判定行）"。
   * 现在：导航按新形态走，并把断言补齐。
   */
  const bad = [];
  if (report.error) bad.push(`异常：${String(report.error).slice(0, 160)}`);
  if (!report.dialogOpened) bad.push("设置弹窗没打开");

  /* ① 那一行的值是**选中的音色**，不是写死的名字 */
  if (report.valueBefore === "温柔桃子") bad.push("⭐ 声音选择那行还是写死的「温柔桃子」");

  /* ② 点开有真列表；本机一个音色都没有时也得有明确说法 */
  if (!report.listOpened) bad.push("点「声音选择」没有展开列表（死按钮）");
  if ((report.voiceCount ?? 0) === 0) {
    bad.push("⭐ 列表里一个音色都没有（连「系统默认」都没有）");
  } else if (!report.hasDefault) {
    bad.push("列表里没有「系统默认」这一项（选不回去）");
  }

  /* ③ 选一个 → 那一行跟着变 + 记到本地（跨重启才谈得上"记住"） */
  if (report.picked) {
    if (report.valueAfterPick === report.valueBefore) bad.push("选了音色但那一行没变（选择没生效）");
    if (!report.persisted) bad.push("⭐ 选了音色但没写进 localStorage（下次开还是旧的）");
    if (report.valueAfterReopen !== report.valueAfterPick) {
      bad.push(`重开设置后那一行是 ${JSON.stringify(report.valueAfterReopen)}（应为 ${JSON.stringify(report.valueAfterPick)}）`);
    }
  }

  /* ④ 还禁用的行必须带原因（不能"点不动又不说为什么"） */
  for (const row of report.todoRows ?? []) {
    if (row.disabled && !row.title) bad.push(`「${row.label}」禁用但没说明原因`);
    if (row.disabled === null) bad.push(`设置里找不到「${row.label}」这一行`);
  }

  /* ⑤ 标准套餐显示的是真实通道，不是写死的「已开通」 */
  if (!report.planReflectsChannel) bad.push(`标准套餐没反映出真实通道：${JSON.stringify(report.planRow)}`);

  verdict(bad, "声音选择接真：列表来自系统音色 / 选了那一行就变且存本地 / 重开还在 / 禁用行都带原因 / 标准套餐反映真实通道");

  await browser.close().catch(() => undefined);
  child.kill();
}
