// B3 验收：附件三路（`+` 菜单 / 文件选择 / 拖拽）都进 chip，可移除。
//
// 不调模型：只验 UI 到"附件进入这一轮"为止。真正的模态校验在
// `engine/runtime/messageTransform.ts`（有单测：模型没声明图片输入时发请求前抛错）。
import fs from "node:fs";
import { chromium } from "playwright";
import { openApp, expandComposerMore, sleep, killLeftovers, freshDir, pickPort } from "./harness.mjs";

const bad = [];
let count = 0;

async function step(name, fn) {
  count += 1;
  try {
    const detail = await fn();
    console.log(`   ✓ ${name}${detail ? "  —— " + detail : ""}`);
  } catch (error) {
    const msg = String(error?.message ?? error)
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .slice(0, 3)
      .join(" ⏐ ")
      .slice(0, 240);
    bad.push(`${name}（${msg}）`);
    console.log(`   ✗ ${name}  —— ${msg}`);
  }
}

await killLeftovers();
await freshDir(".verify/accept-attachments-data");
const port = await pickPort([9971]);
let app = await openApp(chromium, {
  port,
  dataDir: ".verify/accept-attachments-data",
  cwd: ".",
});
let browser = app.browser;
let page = app.page;
let getLog = app.getLog;
await sleep(2200);
/* C-01：附件按钮收在首页的「更多」后面 */
await expandComposerMore(page);

const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);

await step("⭐ 文件选择器加图片 → chip 出现", async () => {
  await page.locator('[data-testid="wb-attach-input"]').setInputFiles({
    name: "shot.png",
    mimeType: "image/png",
    buffer: png,
  });
  await sleep(500);
  if (!(await page.locator('[data-testid="wb-attachment-chip-shot.png"]').count())) {
    throw new Error("没有附件 chip");
  }
  return "图片：shot.png";
});

await step("拖拽一个 PDF → chip 出现", async () => {
  const ok = await page.evaluate(() => {
    const el = document.querySelector('[data-testid="wb-composer"]');
    if (!el) return "no-composer";
    const dt = new DataTransfer();
    dt.items.add(new File([new Uint8Array([0x25, 0x50, 0x44, 0x46])], "doc.pdf", { type: "application/pdf" }));
    el.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: dt }));
    return "dispatched";
  });
  if (ok !== "dispatched") throw new Error(ok);
  await sleep(500);
  if (!(await page.locator('[data-testid="wb-attachment-chip-doc.pdf"]').count())) {
    throw new Error("拖拽后没有 PDF chip");
  }
  return "PDF：doc.pdf";
});

await step("点 × 移除一个附件", async () => {
  const chip = page.locator('[data-testid="wb-attachment-chip-shot.png"]');
  await chip.locator("button").click();
  await sleep(300);
  if (await page.locator('[data-testid="wb-attachment-chip-shot.png"]').count()) throw new Error("图片 chip 还在");
  if (!(await page.locator('[data-testid="wb-attachment-chip-doc.pdf"]').count())) throw new Error("另一个 chip 被误删");
  return "只删掉点中的那个";
});

await step("+ 菜单里有「图片 / PDF」入口", async () => {
  await page.locator('[data-testid="wb-composer-add"]').click();
  await sleep(250);
  if (!(await page.locator('[data-testid="wb-add-attachment"]').count())) throw new Error("菜单里没有入口");
  return "入口在";
});

await step("G2：⭐ 粘贴图片发送 → 步骤里存元数据（不含 base64）", async () => {
  await page.locator('[data-testid="wb-attach-input"]').setInputFiles({
    name: "persist.png",
    mimeType: "image/png",
    buffer: png,
  });
  await sleep(400);
  const input = page.locator('[data-testid="wb-composer-input"]');
  await input.fill("看图");
  await input.press("Enter");
  /*
   * 没有 provider 时这一轮会失败，但任务与用户步骤已经落盘（防抖 600ms）。
   * ⚠️ 任务的权威位置是 KV（`stores.db`）；`tasks.json` 只是旧格式的迁移来源。
   * 所以这里走 `shell.tasks.load()`，不直接读文件。
   */
  let raw = "";
  for (let i = 0; i < 20; i += 1) {
    await sleep(400);
    const tasks = await page.evaluate(() => window.shell?.tasks?.load?.());
    raw = JSON.stringify(tasks ?? []);
    if (raw.includes("persist.png")) break;
  }
  if (!raw.includes("persist.png")) {
    const onTask = await page.locator('[data-testid="wb-task"]').count();
    const body = await page.locator("body").innerText();
    throw new Error(`任务里没出现附件元数据（task 视图=${onTask}；页面尾部：${body.slice(-160)}）`);
  }
  if (raw.includes("iVBORw0KGgo")) throw new Error("任务存储里出现了 base64（应为空）");
  const tasks = JSON.parse(raw);
  const task = tasks.find((t) => t.steps?.some((s) => s.attachments?.length));
  if (!task) throw new Error("tasks.json 里找不到带附件的步骤");
  const step = task.steps.find((s) => s.attachments?.length);
  const meta = step.attachments[0];
  for (const field of ["path", "mediaType", "bytes", "sha256", "name"]) {
    if (meta[field] === undefined) throw new Error(`附件元数据缺 ${field}`);
  }
  if (!fs.existsSync(meta.path)) throw new Error(`附件文件不在：${meta.path}`);
  return `${task.id} · ${meta.name} · ${meta.bytes} 字节`;
});

await step("G2：⭐ 重启后缩略图仍在（点开可预览）", async () => {
  await browser.close();
  await killLeftovers();
  const againPort = await pickPort([9972]);
  app = await openApp(chromium, {
    port: againPort,
    dataDir: ".verify/accept-attachments-data",
    cwd: ".",
  });
  browser = app.browser;
  page = app.page;
  getLog = app.getLog;
  await sleep(2400);
  await page.locator('[data-testid="wb-center-open"]').click();
  await sleep(500);
  const rows = page.locator('[data-testid^="wb-center-row-"]');
  if (!(await rows.count())) throw new Error("重启后任务中心是空的");
  await rows.first().locator("button").first().click();
  await sleep(1200);
  const thumb = page.locator('[data-testid^="wb-attachment-thumb-"]').first();
  for (let i = 0; i < 8 && !(await thumb.count()); i += 1) await sleep(300);
  if (!(await thumb.count())) {
    const dump = JSON.stringify(await page.evaluate(() => window.shell?.tasks?.load?.()) ?? []);
    throw new Error(`重启后没有附件缩略图（store 里 attachments=${dump.includes('"attachments"')}）`);
  }
  const src = await thumb.locator("img").getAttribute("src");
  if (!src?.startsWith("data:image/png;base64,")) throw new Error(`缩略图 src 不是 data URL：${src?.slice(0, 40)}`);
  await thumb.click();
  await sleep(300);
  await sleep(250);
  if (!(await page.locator(".wb-attachment-preview").count())) throw new Error("点开后没有预览");
  /* 预览是最后一步，不再尝试关闭（下一次运行会 freshDir） */
  return "重启后缩略图 + 预览都在";
});

if (bad.length) {
  console.log(`\nB3 验收失败 ${bad.length}/${count}：`);
  for (const item of bad) console.log(`  - ${item}`);
  console.log("启动日志（尾部）：\n" + getLog().split("\n").slice(-20).join("\n"));
} else {
  console.log(`\nB3 验收通过（${count}/${count}）`);
}

await browser.close();
await killLeftovers();
process.exit(bad.length ? 1 : 0);
