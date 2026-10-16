/*
 * ⚠️ **已退役（2026-10-16）—— 保留作墓碑，不要拿它证明任何事。**
 *
 * 它整条都建在**画布对话侧栏**上：`wb-canvas-chat-toggle` 开侧栏、点 `probe-providers` 触发真探测、
 * 再读 `.chat-provider select` 的选项与 `.chat-compose .side-input` / `.chat-send` 发一句真对话，
 * 验"探测之后界面把已验证的通道标出来"。那套界面（`src/chat/ChatSidebar.tsx`）后来被拆掉了 ——
 * 现在这些 testid 在源码里一个都不存在，脚本点哪儿都不响。
 *
 * 现状（如实记）：
 *   · 它**不在**批跑里（`verify-acceptances.mjs` 的 `NOT_IN_BATCH`，kind=`retired`）；
 *   · **它的覆盖面目前没有替代品**：「真探测 → 界面标出已验证」这条**没有别的验收在盯**。
 *     探测逻辑本身在 `electron/ipc/aiProbe.ts`（真发一次极短请求 + 记健康账本），
 *     界面上现在由设置里的模型页承担。要重新覆盖，按现界面重写一条（别复活这份）。
 */
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import fs from "node:fs";
import { connectWithRetry, failOnMarks, openCanvas, pickPort, waitForPort } from "./harness.mjs";

/* ⚠️ 2026-10-16（审计 G15）：这份脚本原来只把 ✗ 印出来、从不改退出码 —— 批跑里等于没测 */
failOnMarks();

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
const DATA = ".verify/probe-data";
fs.rmSync(DATA, { recursive: true, force: true });
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
env.DSH_CANVAS_DATA_DIR = DATA;

/* 这台机器的回环端口会随机连不上（见 harness.pickPort）→ 起之前先挑一个能用的。 */
const __port = await pickPort([12390]);
const child = spawn(
  "node_modules/electron/dist/electron.exe",
  [".", "--remote-debugging-port=" + __port],
  { cwd: ".", env, stdio: ["ignore", "ignore", "ignore"] },
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
