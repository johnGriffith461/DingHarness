import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { connectWithRetry, openCanvas, shot } from "./harness.mjs";

const OUT = ".verify/shots-p3";
mkdirSync(OUT, { recursive: true });

// 启动 Electron（不带 ELECTRON_RUN_AS_NODE —— 带上的话 electron.exe 会退化成纯 Node）
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

/*
 * 数据目录必须隔离 —— 否则读写真实 userData：自己拿不到预置数据，
 * 还会把状态写进真实目录、污染批跑里后续的条目（§109 撞到过一次）。
 */
const DATA_DIR = ".verify/p3-data";
rmSync(DATA_DIR, { recursive: true, force: true });
env.DSH_CANVAS_DATA_DIR = DATA_DIR;
const PORT = "9931";
env.DSH_DEBUG_PORT = PORT;

const child = spawn(
  "node_modules/electron/dist/electron.exe",
  [".", `--remote-debugging-port=${PORT}`],
  { cwd: ".", env, stdio: ["ignore", "pipe", "pipe"] },
);
let stderr = "";
child.stderr.on("data", (d) => {
  stderr += String(d);
});

await new Promise((r) => setTimeout(r, 6000));

const browser = await connectWithRetry(chromium, `http://127.0.0.1:${PORT}`);
const contexts = browser.contexts();
// 主进程开了 devtools（detach），CDP 里会多一个 devtools:// 页面，要挑出真正的主窗口
const pages = contexts[0].pages();
const page = pages.find((p) => !p.url().startsWith("devtools://")) ?? pages[0];
await page.waitForSelector('[data-testid="wb"]', { timeout: 25000 });
await page.waitForTimeout(1800);
  await openCanvas(page);
  await page.waitForTimeout(1500);

await page.waitForSelector(".react-flow__node", { timeout: 30000, state: "attached" });
await page.waitForTimeout(2000);

const r = {};
r.title = await page.title();
r.nodeCount = await page.locator(".react-flow__node").count();
r.hasChat = (await page.locator(".chat-list").count()) > 0;
r.providerOptions = await page.$$eval(".chat-provider select option", (els) =>
  els.map((e) => ({ text: e.textContent, disabled: e.disabled })),
).catch(() => []);

// ---- 聊天：先注入假模型（不烧真额度），验证整条流式链路 ----
await page.evaluate(() => {
  window.__aiLog = [];
  const orig = window.shell.ai.chat.bind(window.shell.ai);
  window.shell.ai.chat = async (req) => {
    const started = await orig(req);
    window.__aiLog.push({ provider: req.provider, model: req.model, requestId: started.requestId, lastUser: req.messages.at(-1).content.slice(0, 80) });
    return started;
  };
});

// ---- 用真实 provider 发一条极短消息，验证端到端流式 ----
/*
 * 下面要用的 `.chat-compose` 在**画布对话侧栏**里（ChatSidebar，条件 canvasChatOpen）。
 * 所以从这里开始就已经依赖侧栏已开 —— 导航补在**这一行之前**。
 *（§104 的教训：补在报错那一行之前太晚，中间读侧栏的调用会先失败。）
 */
/*
 * 画布要开着才能点它侧栏的对话（§104 / §114 的教训都在这一处）。
 * 现在是 `openCanvas(page)` —— 它**幂等**（已经开着就直接返回），
 * 所以不用再自己判状态；当年那个"开关点两下会关掉"的坑由助手兜住了。
 */
await openCanvas(page);
await page.waitForTimeout(1500);
await page.waitForSelector('[data-testid="wb-canvas-chat-toggle"]', { timeout: 10000 });
await page.locator('[data-testid="wb-canvas-chat-toggle"]').click();
await page.waitForTimeout(2000);
const composer = page.locator(".chat-compose textarea");
await composer.fill("只回复两个字：可以");
await composer.press("Enter");
await page.waitForTimeout(9000);

r.chat = await page.evaluate(() => {
  const bubbles = Array.from(document.querySelectorAll(".chat-msg")).map((el) => ({
    role: el.className.includes("user") ? "user" : "assistant",
    text: el.querySelector(".chat-bubble")?.textContent?.slice(0, 120) ?? "",
    error: el.querySelector(".chat-msg-error")?.textContent?.trim() ?? null,
    meta: el.querySelector(".chat-meta")?.textContent?.trim() ?? null,
  }));
  return { bubbles, log: window.__aiLog, provider: document.querySelector(".chat-provider select")?.value };
});
await shot(page, `${OUT}/01-chat.png`);

// ---- 画布生成：选中两个节点 → AI 生成 → 结果落成新节点 ----
const before = await page.locator(".react-flow__node").count();
await page.evaluate(() => {
  // 通过 UI 选中：点选模式下依次点两个节点
  document.querySelector('.canvas-mode[data-mode="point"]').click();
});
const boxes = await page.evaluate(() =>
  ["n1", "n2"].map((id) => {
    const b = document.querySelector(`.react-flow__node[data-id="${id}"]`).getBoundingClientRect();
    return { x: b.x + b.width / 2, y: b.y + 8 };
  }),
);
for (const p of boxes) {
  await page.mouse.click(p.x, p.y, { modifiers: ["Control"] });
  await page.waitForTimeout(250);
}
r.selectedForGen = await page.$$eval(".react-flow__node.selected", (els) => els.map((e) => e.getAttribute("data-id")));

await page.locator('[data-testid="ai-generate"]').click();
await page.waitForTimeout(300);
await page.locator('.canvas-menu button[data-intent="write"]').click();
await page.waitForTimeout(12000);

r.afterGenerate = await page.evaluate(() => {
  const nodes = Array.from(document.querySelectorAll(".react-flow__node")).map((el) => ({
    id: el.getAttribute("data-id"),
    type: el.querySelector(".nv")?.className.replace("nv ", "").split(" ")[0],
    genbar: el.querySelector(".nv-gen-state")?.textContent?.trim() ?? null,
  }));
  return { nodes, toast: document.querySelector(".canvas-toast")?.textContent?.trim() ?? null };
});
r.nodeDelta = (await page.locator(".react-flow__node").count()) - before;
await shot(page, `${OUT}/02-generate.png`);

// ---- 重生成（多版本）：点第 3 版节点的重试，看版本号是否变 ----
const generatedId = r.afterGenerate.nodes.at(-1)?.id;
let versionInfo = null;
if (generatedId) {
  await page.evaluate((id) => {
    const el = document.querySelector(`.react-flow__node[data-id="${id}"] .nv-gen-retry`);
    el?.click();
  }, generatedId);
  await page.waitForTimeout(12000);
  versionInfo = await page.evaluate((id) => {
    const el = document.querySelector(`.react-flow__node[data-id="${id}"]`);
    return {
      state: el?.querySelector(".nv-gen-state")?.textContent?.trim() ?? null,
      hasNav: Boolean(el?.querySelector(".nv-gen-nav")),
      text: el?.querySelector(".nv-markdown-body")?.textContent?.slice(0, 100) ?? null,
    };
  }, generatedId);
}
r.regenerate = versionInfo;
await shot(page, `${OUT}/03-regenerate.png`);

r.stderrHead = stderr.split("\n").filter(Boolean).slice(0, 6);
console.log(JSON.stringify(r, null, 2));

await browser.close();
child.kill();
