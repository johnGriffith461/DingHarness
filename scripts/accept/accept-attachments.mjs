// B3 验收：附件三路（`+` 菜单 / 文件选择 / 拖拽）都进 chip，可移除。
//
// 不调模型：只验 UI 到"附件进入这一轮"为止。真正的模态校验在
// `engine/runtime/messageTransform.ts`（有单测：模型没声明图片输入时发请求前抛错）。
import { chromium } from "playwright";
import { openApp, sleep, killLeftovers, freshDir, pickPort } from "./harness.mjs";

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
const { browser, page, getLog } = await openApp(chromium, {
  port,
  dataDir: ".verify/accept-attachments-data",
  cwd: ".",
});
await sleep(2200);

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
