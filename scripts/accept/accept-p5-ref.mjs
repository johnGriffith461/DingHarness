import { chromium } from "playwright";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/**
 * 节点引用芯片端到端验收（阶段 5.4）。
 *
 * 断言的是**真实发给模型的消息体**（dev 期挂在 `window.__lastChatPayload`）：
 *   · 打 @ 会弹候选列表
 *   · 点候选 → 输入框出现 `@标题`，并出现引用芯片
 *   · 发出去的请求里带 `【对话里的节点引用】` 与目标节点 id
 *   · 断链引用（节点已删）会被显式标注
 */

const DATA = "D:/DoubaoWorkClone/data";
fs.rmSync(path.join(DATA, "canvas"), { recursive: true, force: true });
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
env.DSH_CANVAS_DATA_DIR = DATA;

const child = spawn(
  "D:/DoubaoWorkClone/node_modules/electron/dist/electron.exe",
  [".", "--remote-debugging-port=9350"],
  { cwd: "D:/DoubaoWorkClone", env, stdio: ["ignore", "ignore", "ignore"] },
);
await new Promise((r) => setTimeout(r, 8000));

const browser = await chromium.connectOverCDP("http://127.0.0.1:9350");
const pages = browser.contexts()[0].pages();
const page = pages.find((p) => !p.url().startsWith("devtools://")) ?? pages[0];
await page.waitForSelector('[data-testid="wb"]', { timeout: 25000 });
await page.waitForTimeout(1800);
  await page.locator('[data-testid="wb-canvas-toggle"]').click();
  await page.waitForTimeout(1500);

await page.waitForSelector(".react-flow__node", { state: "attached" });
await page.waitForTimeout(2500);

const report = {};
const textarea = page.locator(".chat-compose .side-input");

// 1) 打 @ → 候选列表
await textarea.click();
await textarea.fill("@");
await page.waitForTimeout(400);
report.candidatesShown = await page.locator('[data-testid="chat-mentions"] .chat-mention-item').count();
report.candidateLabels = await page.locator(".chat-mention-label").allTextContents();

// 2) 点第一个候选
await page.locator('[data-testid="chat-mentions"] .chat-mention-item').first().click();
await page.waitForTimeout(300);
report.draftAfterPick = await textarea.inputValue();
report.chips = await page.locator('[data-testid="chat-refchips"] .chat-refchip').allTextContents();

// 3) 补一句话再发送
await textarea.fill((await textarea.inputValue()) + "帮我压缩成三行");
await page.waitForTimeout(300);
report.chipsBeforeSend = await page.locator('[data-testid="chat-refchips"] .chat-refchip').count();
await page.locator(".chat-send").click();
await page.waitForTimeout(9000);

report.payload = await page.evaluate(() => {
  const p = window.__lastChatPayload ?? null;
  if (!p) return null;
  const last = p[p.length - 1];
  return { role: last.role, content: last.content };
});

// 4) 断链：删掉被引用的节点后再发，应显式标注
report.brokenCase = await page.evaluate(async () => {
  const store = window.__canvasStore;
  if (!store) return "no-store";
  const before = store.getState().nodes.map((n) => n.id);
  store.getState().applyNodeChanges([{ id: before[0], type: "remove" }]);
  return store.getState().nodes.map((n) => n.id);
});
await textarea.fill("@使用说明 再说一次");
await page.waitForTimeout(400);
report.chipsAfterDelete = await page.locator('[data-testid="chat-refchips"] .chat-refchip').count();
report.chipBrokenClass = await page
  .locator('[data-testid="chat-refchips"] .chat-refchip')
  .first()
  .getAttribute("class")
  .catch(() => null);

await page.screenshot({ path: "D:/DoubaoWorkClone/.verify/shots-p5/05-refchips.png" });
console.log(JSON.stringify(report, null, 2));

await browser.close();
child.kill();
