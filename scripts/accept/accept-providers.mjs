import { chromium } from "playwright";
import { spawn } from "node:child_process";
import fs from "node:fs";
import { connectWithRetry, openCanvas, pickPort, waitForPort } from "./harness.mjs";

/**
 * provider 可用性诚实度验收。
 *
 * 背景：以前"有密钥"就显示可用，但本机实测 apihub 域名不可达、通义千问 400、
 * 本地服务没起 —— 用户点下去才发现用不了。现在拆成两级：
 *   有密钥但没验证 → 标签写「（未验证）」并提示"还没验证过这家能不能真调用"
 *   真调用成功过   → 标签写「（已验证）」
 *
 * 断言：
 *   1. 初始下拉里，有密钥的显示「（未验证）」，没密钥的显示「（无密钥）」
 *   2. 点「探测」真的跑一轮，结果落到下拉标签上
 *   3. 真发一次对话成功后，该 provider 变「（已验证）」
 */
const DATA = "D:/DoubaoWorkClone/.verify/probe-data";
fs.rmSync(DATA, { recursive: true, force: true });
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
env.DSH_CANVAS_DATA_DIR = DATA;

/* 这台机器的回环端口会随机连不上（见 harness.pickPort）→ 起之前先挑一个能用的。 */
const __port = await pickPort([12390]);
const child = spawn(
  "D:/DoubaoWorkClone/node_modules/electron/dist/electron.exe",
  [".", "--remote-debugging-port=" + __port],
  { cwd: "D:/DoubaoWorkClone", env, stdio: ["ignore", "ignore", "ignore"] },
);
/* 固定等 8 秒会在机器忙时不够（应用还没监听）→ 改成轮询端口：实测过的失败形态是 `ECONNREFUSED`（= 什么都没在听，不是端口坏）。 */
await waitForPort(__port, 40000);

const browser = await connectWithRetry(chromium, "http://127.0.0.1:" + __port);
const pages = browser.contexts()[0].pages();
const page = pages.find((p) => !p.url().startsWith("devtools://")) ?? pages[0];
await page.waitForSelector('[data-testid="wb"]', { timeout: 25000 });
await page.waitForTimeout(1800);
  await openCanvas(page);
  await page.waitForTimeout(1500);

await page.waitForSelector(".react-flow__node", { state: "attached" });
await page.waitForTimeout(2500);

/*
 * `probe-providers` 与下面要读的 `.chat-provider select` 都在**画布对话侧栏**里
 * （src/chat/ChatSidebar.tsx），它挂在 `.wb-canvas` 内、条件是 canvasChatOpen。
 *
 * 所以**从这里开始就已经依赖侧栏已开** —— 导航必须补在这一行之前。
 * （§104：上一版补在点击那行之前，太晚 —— 那时侧栏还是空的。
 *   "同一个症状"不等于"同一个插入点"。）
 */
await page.waitForSelector('[data-testid="wb"]', { timeout: 25000 });
await page.waitForTimeout(1800);
  await openCanvas(page);
  await page.waitForTimeout(1500);
await page.locator('[data-testid="wb-canvas-chat-toggle"]').click();
await page.waitForTimeout(2000);

const options = () =>
  page.$$eval(".chat-provider select:first-of-type option", (els) =>
    els.map((e) => e.textContent?.trim() ?? ""),
  );

const report = {};
report.initialOptions = await options();
report.noteVisible = await page.locator(".chat-note").textContent().catch(() => null);

// 点探测（会对每个有密钥的 provider 真发一次极短请求）
await page.locator('[data-testid="probe-providers"]').click();
await page.waitForTimeout(25000);
report.afterProbeOptions = await options();

// 发一次真对话，验证成功后该 provider 应变「已验证」
const ta = page.locator(".chat-compose .side-input");
await ta.fill("只回复两个字：可以");
await page.locator(".chat-send").click();
await page.waitForTimeout(12000);
report.afterChatOptions = await options();
report.bubbles = await page.$$eval(".chat-bubble", (els) =>
  els.map((e) => e.textContent?.trim().slice(0, 30)),
);

console.log(JSON.stringify(report, null, 2));
await browser.close();
child.kill();
