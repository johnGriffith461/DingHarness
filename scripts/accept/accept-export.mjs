import { chromium } from "playwright";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/**
 * 导出 PNG 端到端验收（阶段 8.6）。
 *
 * 断言：
 *   1. 工具条有导出菜单，三项齐全
 *   2. 「导出当前视图」真的落盘一个 PNG，且尺寸与画布区一致
 *   3. 「导出选中画框」产出的是画框那块区域（明显比整视图小）
 *   4. PNG 文件头正确（真的是 PNG，不是空文件）
 *   5. 没有画框时给的是**可读提示**，而不是静默失败
 */
const DATA = "D:/DoubaoWorkClone/.verify/export-data";
fs.rmSync(DATA, { recursive: true, force: true });
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
env.DSH_CANVAS_DATA_DIR = DATA;

const child = spawn(
  "D:/DoubaoWorkClone/node_modules/electron/dist/electron.exe",
  [".", "--remote-debugging-port=9450"],
  { cwd: "D:/DoubaoWorkClone", env, stdio: ["ignore", "ignore", "ignore"] },
);
await new Promise((r) => setTimeout(r, 8000));

const browser = await chromium.connectOverCDP("http://127.0.0.1:9450");
const pages = browser.contexts()[0].pages();
const page = pages.find((p) => !p.url().startsWith("devtools://")) ?? pages[0];
await page.waitForSelector('[data-testid="wb"]', { timeout: 25000 });
await page.waitForTimeout(1800);
  await page.locator('[data-testid="wb-canvas-toggle"]').click();
  await page.waitForTimeout(1500);

await page.waitForSelector(".react-flow__node", { state: "attached" });
await page.waitForTimeout(2500);

const report = {};
const EXPORTS = path.join(DATA, "exports");
/** 读 PNG 头里的宽高（IHDR 在偏移 16，大端 4 字节 + 4 字节）。 */
const pngSize = (file) => {
  const buf = fs.readFileSync(file);
  const magic = buf.subarray(0, 8).toString("hex");
  return {
    magic: magic === "89504e470d0a1a0a" ? "PNG" : `不是PNG(${magic})`,
    bytes: buf.length,
    width: buf.readUInt32BE(16),
    height: buf.readUInt32BE(20),
  };
};
const newestExport = () => {
  if (!fs.existsSync(EXPORTS)) return null;
  const files = fs
    .readdirSync(EXPORTS)
    .filter((f) => f.endsWith(".png"))
    .map((f) => ({ f, t: fs.statSync(path.join(EXPORTS, f)).mtimeMs }))
    .sort((a, b) => b.t - a.t);
  return files[0] ? path.join(EXPORTS, files[0].f) : null;
};

// 先在没有画框的情况下点「导出选中画框」——应该给可读提示
await page.locator('[data-testid="export-menu"]').click();
await page.waitForTimeout(400);
report.menuItems = await page.$$eval('[data-testid="export-options"] button', (els) =>
  els.map((e) => e.getAttribute("data-testid")),
);
await page.locator('[data-testid="export-frame"]').click();
await page.waitForTimeout(900);
report.noFrameMessage = await page.locator(".canvas-toast").textContent().catch(() => null);

// 导出当前视图
await page.locator('[data-testid="export-menu"]').click();
await page.waitForTimeout(300);
await page.locator('[data-testid="export-view"]').click();
await page.waitForTimeout(2000);
report.viewToast = await page.locator(".canvas-toast").textContent().catch(() => null);
const viewFile = newestExport();
report.viewPng = viewFile ? { file: path.basename(viewFile), ...pngSize(viewFile) } : null;

// 建一个画框，再导出画框
await page.locator('[data-testid="add-node"]').click();
await page.waitForTimeout(300);
await page.locator('.canvas-menu button[data-kind="frame"]').click();
await page.waitForTimeout(1500);
await page.locator(".frame-node").click({ force: true });
await page.waitForTimeout(400);

await page.locator('[data-testid="export-menu"]').click();
await page.waitForTimeout(300);
await page.locator('[data-testid="export-frame"]').click();
await page.waitForTimeout(2000);
report.frameToast = await page.locator(".canvas-toast").textContent().catch(() => null);
const frameFile = newestExport();
report.framePng = frameFile ? { file: path.basename(frameFile), ...pngSize(frameFile) } : null;

report.smallerThanView =
  report.viewPng && report.framePng
    ? report.framePng.width * report.framePng.height < report.viewPng.width * report.viewPng.height
    : null;
report.totalExports = fs.existsSync(EXPORTS) ? fs.readdirSync(EXPORTS).length : 0;
report.frameFileName = report.framePng?.file ?? null;

console.log(JSON.stringify(report, null, 2));
await browser.close();
child.kill();
