import { chromium } from "playwright";
import { writeFileSync, mkdirSync } from "node:fs";
import { openCanvas, shot } from "./harness.mjs";

const OUT = "D:/DoubaoWorkClone/.verify/shots-p2";
mkdirSync(OUT, { recursive: true });

// 造一张纯色测试图（800×600，用最小 PNG 头合成不方便，直接写 SVG 后让浏览器读成 dataURL 不行，
// 所以用 canvas 在页面里生成并喂给 input）
const browser = await chromium.launch({
  headless: true,
  executablePath:
    "C:/Users/Administrator/AppData/Local/ms-playwright/chromium-1243/chrome-win64/chrome.exe",
});
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
const problems = [];
page.on("console", (m) => {
  if (m.type() === "error" || m.type() === "warning") problems.push(`[${m.type()}] ${m.text().slice(0, 200)}`);
});
page.on("pageerror", (e) => problems.push(`[pageerror] ${e.message.slice(0, 200)}`));

await page.goto("http://localhost:5173", { waitUntil: "networkidle" });
await page.waitForSelector('[data-testid="wb"]', { timeout: 25000 });
await page.waitForTimeout(1800);
  await openCanvas(page);
  await page.waitForTimeout(1500);

await page.waitForSelector(".react-flow__node");
await page.waitForTimeout(2000);

// 生成一张 800x600 的 PNG 落到临时文件
const pngBase64 = await page.evaluate(() => {
  const c = document.createElement("canvas");
  c.width = 800;
  c.height = 600;
  const ctx = c.getContext("2d");
  const g = ctx.createLinearGradient(0, 0, 800, 600);
  g.addColorStop(0, "#3b82f6");
  g.addColorStop(0.5, "#a855f7");
  g.addColorStop(1, "#f59e0b");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 800, 600);
  ctx.fillStyle = "#ffffff";
  ctx.font = "bold 64px sans-serif";
  ctx.fillText("800x600", 250, 320);
  return c.toDataURL("image/png").split(",")[1];
});
const tmp = "D:/DoubaoWorkClone/.verify/sample-800x600.png";
writeFileSync(tmp, Buffer.from(pngBase64, "base64"));

// 上传到图片节点
const fileInput = page.locator('.react-flow__node[data-id="n5"] input[type="file"]');
await fileInput.setInputFiles(tmp);
await page.waitForTimeout(1500);

const afterUpload = await page.evaluate(() => {
  const n = window.__canvasStore.getState().nodes.find((x) => x.id === "n5");
  return {
    hasSrc: Boolean(n.data.src) && n.data.src.startsWith("data:image/png"),
    alt: n.data.alt,
    natural: n.data.natural,
    crop: n.data.crop,
    imgRendered: document.querySelectorAll('.react-flow__node[data-id="n5"] img.nv-image-img').length,
    meta: document.querySelector('.react-flow__node[data-id="n5"] .nv-image-meta')?.textContent ?? null,
  };
});
console.log("上传后 =", JSON.stringify(afterUpload, null, 1));
await shot(page, `${OUT}/10-image-uploaded.png`);

// 打开裁剪，拖右下角，应用
const cropBtn = page.locator('.react-flow__node[data-id="n5"] button[title="裁剪"]');
if (await cropBtn.count()) {
  await cropBtn.click();
  await page.waitForTimeout(500);
  const boxInfo = await page.evaluate(() => {
    const box = document.querySelector('.react-flow__node[data-id="n5"] .nv-crop-box');
    const stage = document.querySelector('.react-flow__node[data-id="n5"] .nv-crop');
    if (!box || !stage) return null;
    const br = box.getBoundingClientRect();
    const sr = stage.getBoundingClientRect();
    return {
      box: [Math.round(br.x), Math.round(br.y), Math.round(br.width), Math.round(br.height)],
      stage: [Math.round(sr.x), Math.round(sr.y), Math.round(sr.width), Math.round(sr.height)],
      handleCount: document.querySelectorAll('.react-flow__node[data-id="n5"] .nv-crop-h').length,
    };
  });
  console.log("裁剪态 =", JSON.stringify(boxInfo));
  await shot(page, `${OUT}/11-crop-mode.png`);

  // 拖右下角手柄：把裁剪框缩小到左侧 60%
  if (boxInfo) {
    const [sx, sy, sw, sh] = boxInfo.stage;
    const handle = await page.locator('.react-flow__node[data-id="n5"] .nv-crop-h.se').boundingBox();
    if (handle) {
      await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
      await page.mouse.down();
      await page.mouse.move(sx + sw * 0.6, sy + sh * 0.7, { steps: 12 });
      await page.mouse.up();
      await page.waitForTimeout(400);
    }
    const applied = await page.locator('.react-flow__node[data-id="n5"] button[title="应用裁剪"]');
    if (await applied.count()) {
      await applied.click();
      await page.waitForTimeout(700);
    }
  }
}
const afterCrop = await page.evaluate(() => {
  const n = window.__canvasStore.getState().nodes.find((x) => x.id === "n5");
  const img = document.querySelector('.react-flow__node[data-id="n5"] img.nv-image-img');
  return {
    crop: n.data.crop,
    natural: n.data.natural,
    tag: document.querySelector('.react-flow__node[data-id="n5"] .nv-tag')?.textContent ?? null,
    style: img?.getAttribute("style")?.slice(0, 120) ?? null,
    meta: document.querySelector('.react-flow__node[data-id="n5"] .nv-image-meta')?.textContent ?? null,
  };
});
console.log("裁剪后 =", JSON.stringify(afterCrop, null, 1));
await shot(page, `${OUT}/12-after-crop.png`);

// 复原
const resetBtn = page.locator('.react-flow__node[data-id="n5"] button[title="复原为原图"]');
if (await resetBtn.count()) {
  await resetBtn.click();
  await page.waitForTimeout(600);
}
console.log(
  "复原后 =",
  JSON.stringify(
    await page.evaluate(() => {
      const n = window.__canvasStore.getState().nodes.find((x) => x.id === "n5");
      return { crop: n.data.crop, tag: document.querySelector('.react-flow__node[data-id="n5"] .nv-tag')?.textContent ?? null };
    }),
  ),
);

// 导图与图表视觉复检
await page.getByTitle("适配视图（一键全览）").click();
await page.waitForTimeout(1500);
console.log(
  "导图 svg 尺寸 =",
  JSON.stringify(
    await page.evaluate(() => {
      const svg = document.querySelector(".nv-mindmap .nv-graph-svg");
      const r = svg?.getBoundingClientRect();
      const g = svg?.querySelector("g");
      const gr = g?.getBoundingClientRect();
      return {
        svg: r ? [Math.round(r.width), Math.round(r.height)] : null,
        content: gr ? [Math.round(gr.x - (r?.x ?? 0)), Math.round(gr.y - (r?.y ?? 0)), Math.round(gr.width), Math.round(gr.height)] : null,
        foreign: svg?.querySelectorAll("foreignObject").length ?? 0,
      };
    }),
  ),
);
console.log(
  "图表 svg 尺寸 =",
  JSON.stringify(
    await page.evaluate(() => {
      const svg = document.querySelector(".nv-mermaid-svg svg");
      const host = document.querySelector(".nv-mermaid-svg");
      const r = svg?.getBoundingClientRect();
      const h = host?.getBoundingClientRect();
      return { svg: r ? [Math.round(r.width), Math.round(r.height)] : null, host: h ? [Math.round(h.width), Math.round(h.height)] : null };
    }),
  ),
);
await shot(page, `${OUT}/13-final-p2.png`);

console.log("\nproblems =", JSON.stringify(problems, null, 1));
await browser.close();
