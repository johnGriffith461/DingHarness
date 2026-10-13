import { app, BrowserWindow } from "electron";
import fs from "node:fs";
import path from "node:path";

/**
 * 生成应用图标（阶段 9.5）。
 *
 * 两条约束决定了做法：
 *   · 项目里**没有任何图像库**（sharp / jimp / pngjs 都没有），也不想为一个图标引依赖；
 *   · 但 Electron 自带完整的 Chromium —— 直接用离屏窗口把 SVG 渲成 PNG 就行。
 *
 * ⚠️ 踩过的坑：一开始"每个尺寸新建一个窗口"，16px 成了、24px 直接
 * `ERR_FAILED (-2)` —— 上一个窗口刚 destroy 就建下一个存在竞态。
 * 改成一个 256×256 的窗口常驻，逐尺寸替换内容再按尺寸截取，
 * 每个尺寸都得到**真按该尺寸光栅化**的图（缩放靠 width/height 属性，不是事后拉伸）。
 *
 * ICO 容器自己拼：头 + 目录项 + 各帧 PNG。Vista 之后允许内嵌 PNG，
 * 所以不需要写 BMP/DIB 那一套。
 */

const OUT_DIR = "D:/DoubaoWorkClone/build";
const SIZES = [16, 24, 32, 48, 64, 128, 256];
const MAX = 256;

/**
 * 图标主体：深色圆角方块 + 画布节点图。
 * 用"三个节点连成一条折线"表达这个应用是什么（无限画布 + 生成物即节点）；
 * 不做字母堆叠 —— 小尺寸下字母会糊成一团。
 */
const svg = (size) => `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 256 256">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#1b2230"/><stop offset="1" stop-color="#0d1219"/>
    </linearGradient>
    <linearGradient id="accent" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#7dd3fc"/><stop offset="1" stop-color="#3b82f6"/>
    </linearGradient>
    <linearGradient id="warm" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#fbbf24"/><stop offset="1" stop-color="#f97316"/>
    </linearGradient>
  </defs>
  <rect x="8" y="8" width="240" height="240" rx="54" fill="url(#bg)"/>
  <rect x="8" y="8" width="240" height="240" rx="54" fill="none" stroke="#2a3446" stroke-width="4"/>
  <g opacity="0.15" fill="#94a3b8">
    ${Array.from({ length: 5 }, (_, r) =>
      Array.from({ length: 5 }, (_, c) => `<circle cx="${52 + c * 38}" cy="${52 + r * 38}" r="2.8"/>`).join(""),
    ).join("")}
  </g>
  <path d="M78 172 L128 118 L178 156" fill="none" stroke="url(#accent)" stroke-width="14"
        stroke-linecap="round" stroke-linejoin="round"/>
  <path d="M128 118 L128 74" fill="none" stroke="url(#accent)" stroke-width="14"
        stroke-linecap="round" opacity="0.55"/>
  <circle cx="78" cy="172" r="22" fill="url(#accent)"/>
  <circle cx="128" cy="118" r="25" fill="#e8f2ff"/>
  <circle cx="178" cy="156" r="22" fill="url(#warm)"/>
</svg>`;

/**
 * 拼 ICO。
 *
 * 布局：ICONDIR(6 字节) + ICONDIRENTRY×N（每个 16 字节）+ 各帧 PNG 数据。
 * 宽/高各占 1 字节，**256 要写 0**（那一字节放不下 256，规范里用 0 表示 256）。
 */
function buildIco(frames) {
  const count = frames.length;
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type = icon
  header.writeUInt16LE(count, 4);

  let offset = 6 + 16 * count;
  const dir = Buffer.alloc(16 * count);
  frames.forEach((frame, i) => {
    const p = i * 16;
    dir.writeUInt8(frame.size >= 256 ? 0 : frame.size, p + 0);
    dir.writeUInt8(frame.size >= 256 ? 0 : frame.size, p + 1);
    dir.writeUInt8(0, p + 2); // 调色板数
    dir.writeUInt8(0, p + 3);
    dir.writeUInt16LE(1, p + 4); // planes
    dir.writeUInt16LE(32, p + 6); // 位深
    dir.writeUInt32LE(frame.png.length, p + 8);
    dir.writeUInt32LE(offset, p + 12);
    offset += frame.png.length;
  });

  return Buffer.concat([header, dir, ...frames.map((f) => f.png)]);
}

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

app.whenReady().then(async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const win = new BrowserWindow({
    width: MAX,
    height: MAX,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    useContentSize: true,
    webPreferences: { offscreen: true, sandbox: true },
  });

  // 先载一个空壳页面，后面只换内容 —— 避免反复创建窗口的竞态
  await win.loadURL(
    "data:text/html;charset=utf-8," + encodeURIComponent("<!doctype html><body style='margin:0;background:transparent'></body>"),
  );

  const frames = [];
  for (const size of SIZES) {
    await win.webContents.executeJavaScript(
      `document.body.innerHTML = ${JSON.stringify(svg(size))}; void 0;`,
    );
    // 等两帧，确保 SVG 已经画上（少等会截到空白）
    await new Promise((r) => setTimeout(r, 220));
    const image = await win.webContents.capturePage({ x: 0, y: 0, width: size, height: size });
    const png = image.toPNG();
    if (png.length < 100 || !png.subarray(0, 8).equals(PNG_MAGIC)) {
      console.error(`尺寸 ${size} 渲染出来的不是有效 PNG（${png.length} 字节）`);
      continue;
    }
    frames.push({ size, png });
    fs.writeFileSync(path.join(OUT_DIR, `icon-${size}.png`), png);
    console.log(`  ${String(size).padStart(3)}×${String(size).padEnd(3)} → ${png.length} 字节`);
  }

  win.destroy();

  if (frames.length === 0) {
    console.error("一帧都没渲染出来");
    app.exit(1);
    return;
  }

  const ico = buildIco(frames);
  fs.writeFileSync(path.join(OUT_DIR, "icon.ico"), ico);

  const big = frames.find((f) => f.size === 256) ?? frames[frames.length - 1];
  fs.writeFileSync(path.join(OUT_DIR, "icon.png"), big.png);

  console.log(`\n已生成 build/icon.ico：${frames.length} 帧，共 ${ico.length} 字节`);
  console.log(`已生成 build/icon.png：${big.png.length} 字节`);
  app.exit(0);
});
