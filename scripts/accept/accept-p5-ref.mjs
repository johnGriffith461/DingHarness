import { chromium } from "playwright";
import { spawn } from "node:child_process";
import fs from "node:fs";
import { shot, verdict } from "./harness.mjs";

/**
 * 节点引用芯片端到端验收（阶段 5.4）。
 *
 * ## 2026-10-14 重写：把两处 DEV 探针断言去掉
 * 原来它断的是"**真的发给模型的消息体**"（`window.__lastChatPayload`）与
 * "用 `window.__canvasStore` 直接删节点" —— 两个都是 `import.meta.env.DEV` 才有的，
 * **打包产物里没有**，而验收跑的就是打包产物。于是这条脚本在任何时候都跑不到那两处
 * （历史上它长期是红的，清单里只留一句"画布引用"）。
 *
 * 现在分成两层，各归各位：
 *   · **请求体长什么样**（引用块 + 节点正文、截断、断链不给正文）→ 单测
 *     `src/canvas/references.test.ts`（28 条，纯函数，不连模型）；
 *   · **界面这一路走不走得通**（打 @ → 候选 → 点选 → 芯片 → 删掉节点后芯片变断链）→ 本脚本，
 *     全部走真实交互（右键菜单删节点），不碰任何内部出口。
 */
const DATA = "D:/DoubaoWorkClone/.verify/p5ref-data";
fs.rmSync(DATA, { recursive: true, force: true });

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
env.DSH_CANVAS_DATA_DIR = DATA;

const child = spawn(
  "D:/DoubaoWorkClone/node_modules/electron/dist/electron.exe",
  [".", "--remote-debugging-port=9350"],
  { cwd: "D:/DoubaoWorkClone", env, stdio: ["ignore", "ignore", "ignore"] },
);
await new Promise((r) => setTimeout(r, 9000));

const browser = await chromium.connectOverCDP("http://127.0.0.1:9350");
const pages = browser.contexts()[0].pages();
const page = pages.find((p) => !p.url().startsWith("devtools://")) ?? pages[0];
await page.waitForSelector('[data-testid="wb"]', { timeout: 25000 });
await page.waitForTimeout(1800);

const report = {};
try {
  report.step = "打开画布与聊天";
  if ((await page.locator('[data-testid="wb-canvas"]').count()) === 0) {
    await page.locator('[data-testid="wb-canvas-toggle"]').click();
    await page.waitForTimeout(2200);
  }
  if ((await page.locator('[data-testid="chat-input"]').count()) === 0) {
    await page.locator('[data-testid="wb-canvas-chat-toggle"]').click();
    await page.waitForTimeout(1500);
  }
  await page.waitForSelector(".react-flow__node", { timeout: 20000 });
  const textarea = page.locator('[data-testid="chat-input"]');

  /* ① 打 @ → 候选列表（列表来自画布上真实存在的节点） */
  report.step = "打 @ 唤出候选";
  await textarea.click();
  await textarea.fill("@");
  await page.waitForTimeout(600);
  report.candidatesShown = await page.locator('[data-testid="chat-mentions"] .chat-mention-item').count();
  report.candidateLabels = await page.locator(".chat-mention-label").allTextContents();

  /* ② 点第一个候选 → 输入框里出现引用、下面出现芯片 */
  report.step = "点候选生成芯片";
  await page.locator('[data-testid="chat-mentions"] .chat-mention-item').first().click();
  await page.waitForTimeout(400);
  report.draftAfterPick = await textarea.inputValue();
  report.chips = await page.locator('[data-testid="chat-refchips"] .chat-refchip').allTextContents();
  report.chipClassOk = await page
    .locator('[data-testid="chat-refchips"] .chat-refchip')
    .first()
    .getAttribute("class");

  /*
   * ③ 断链：用**界面**删掉被引用的那个节点（右键 → 删除），再打一次 @。
   * 芯片要如实标成断链，不许无声消失 —— 那正是这条验收存在的理由。
   */
  report.step = "右键删除被引用的节点";
  await textarea.fill("");
  await page.waitForTimeout(200);
  /*
   * ⚠️ **聊天保持开着**（第一次我把它关了，于是"删完再打 @ 认不出那个标题"——
   * 因为侧栏重挂之后只认识还活着的节点，这个引用场景本来就不存在了）。
   * 正确场景是：芯片还在输入框里 → 节点被删 → 芯片当场变成"断链"。
   *
   * 找一个**上有未被遮挡落点**的节点右键 —— 初始文档里节点互相重叠，
   * 写死序号会随布局失效（这段与 `accept-nodemenu.mjs` 的做法一致，那条一直在跑）。
   */
  const nodes = await page.locator(".react-flow__node").count();
  const spot = await page.evaluate(() => {
    const all = Array.from(document.querySelectorAll(".react-flow__node"));
    const rects = all.map((el) => el.getBoundingClientRect());
    /* 聊天侧栏也是"挡在画布前面的一块"，落点要一并避开（它在画布右侧）。 */
    const side = document.querySelector(".canvas-root .side, .side.left");
    const panel = side ? side.getBoundingClientRect() : null;
    for (let i = 0; i < rects.length; i += 1) {
      const r = rects[i];
      for (let dy = 6; dy < r.height - 6; dy += 6) {
        for (let dx = 6; dx < r.width - 6; dx += 6) {
          const x = r.x + dx;
          const y = r.y + dy;
          if (rects.some((o, j) => j !== i && x >= o.x && x <= o.right && y >= o.y && y <= o.bottom)) continue;
          if (panel && x >= panel.x && x <= panel.right && y >= panel.y && y <= panel.bottom) continue;
          const title = all[i].querySelector(".nv-title")?.textContent?.trim() ?? "";
          const id = all[i].getAttribute("data-id") ?? "";
          return { index: i, x: Math.round(x), y: Math.round(y), title, id };
        }
      }
    }
    return null;
  });
  if (spot) {
    await page.mouse.click(spot.x, spot.y, { button: "right" });
    await page.waitForTimeout(700);
  }
  report.deletedTitle = spot?.title ?? null;
  report.deletedId = spot?.id ?? null;
  report.menuShown = await page.locator('[data-testid="cv-node-menu"]').count();
  if (report.menuShown) {
    await page.locator('[data-testid="cv-ctx-删除"]').click();
    await page.waitForTimeout(1000);
  }
  report.nodesAfterDelete = await page.locator(".react-flow__node").count();
  report.nodesBeforeDelete = nodes;

  /*
   * 原输入框里重新打**完整引用名**（`@某个标题`；光打一个 `@` 只唤候选、不产生芯片）。
   * 节点刚被删掉，这一枚引用应当**当场标成断链**而不是无声消失。
   */
  await textarea.fill(`@${report.deletedTitle ?? "不存在的节点"}`);
  await page.waitForTimeout(800);
  report.chipsAfterDelete = await page.locator('[data-testid="chat-refchips"] .chat-refchip').count();
  report.chipBrokenClass = await page
    .locator('[data-testid="chat-refchips"] .chat-refchip')
    .first()
    .getAttribute("class")
    .catch(() => null);

  await shot(page, "D:/DoubaoWorkClone/.verify/shots-p5/05-refchips.png");
} catch (error) {
  report.error = `在「${report.step ?? "未知"}」这一步失败：${String(error).split(String.fromCharCode(10))[0]}`;
} finally {
  console.log(JSON.stringify(report, null, 2));

  const bad = [];
  if (report.error) bad.push(`异常：${String(report.error).slice(0, 200)}`);
  /* ① 候选来自真节点 */
  if ((report.candidatesShown ?? 0) === 0) bad.push("⭐ 打 @ 没有候选（芯片没有入口）");
  if (!(report.candidateLabels ?? []).length) bad.push("候选列表里没有标题文字");
  /* ② 点选之后确实是引用形态 */
  if (!String(report.draftAfterPick ?? "").includes("@")) bad.push(`点候选后输入框里是 ${JSON.stringify(report.draftAfterPick)}`);
  if (!(report.chips ?? []).length) bad.push("点候选后没有出现引用芯片");
  if (!String(report.chipClassOk ?? "").includes("is-ok")) bad.push(`芯片的初始状态不是 ok：${JSON.stringify(report.chipClassOk)}`);
  /* ③ 断链要如实标注 */
  if (!report.menuShown) bad.push("打不开节点右键菜单（这一步没做成，断链断言不算数）");
  else {
    if (!((report.nodesAfterDelete ?? 99) < (report.nodesBeforeDelete ?? 0))) bad.push("节点没被删掉");
    if (!(report.chipsAfterDelete >= 0)) bad.push("断链后读不到芯片");
    if (!String(report.chipBrokenClass ?? "").includes("is-broken")) {
      bad.push(`引用指向的节点被删了，芯片却还是 ${JSON.stringify(report.chipBrokenClass)}（应标成 is-broken）`);
    }
  }

  verdict(bad, "引用芯片成立：@ 有候选 / 点选生成芯片 / 指向的节点被删后芯片如实标成断链");

  await browser.close().catch(() => undefined);
  child.kill();
  process.exit(process.exitCode ?? 0);
}

