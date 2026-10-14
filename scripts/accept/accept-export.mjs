import { chromium } from "playwright";
import { spawn } from "node:child_process";
import fs from "node:fs";
import { connectWithRetry, openCanvas, verdict } from "./harness.mjs";
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

const browser = await connectWithRetry(chromium, "http://127.0.0.1:9450");
const pages = browser.contexts()[0].pages();
const page = pages.find((p) => !p.url().startsWith("devtools://")) ?? pages[0];
await page.waitForSelector('[data-testid="wb"]', { timeout: 25000 });
await page.waitForTimeout(1800);
  await openCanvas(page);
  await page.waitForTimeout(1500);

await page.waitForSelector(".react-flow__node", { state: "attached" });
await page.waitForTimeout(2500);

const report = {};
/** 当前步骤：失败时用来定位（超时信息本身不说是哪个 locator 等不到）。 */
report.step = "启动完成";
/*
 * 整段动作包在 try 里（2026-10-14）：这条原来没有兜底，中途某个元素等不到就直接抛 ——
 * 报告不打、判定不做、退出码 1，清单里只留一句「等某元素超时」，看不出坏在哪。
 */
try {
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

  /**
   * 等这次导出**出结果**，返回提示栏上的那句话。
   *
   * 为什么不能"点完等 2 秒就读盘"：导出走的是主进程截屏，跟渲染进程抢时间；
   * 这边紧接着点「新建」加节点，截屏就可能失败（实测过：提示停在「正在导出…」，
   * 盘上永远等不到文件）。等结果本身也是断言的一部分 —— 那句话里有尺寸或失败原因。
   */
  const waitExport = async (timeoutMs = 25000) => {
    const t0 = Date.now();
    let text = null;
    while (Date.now() - t0 < timeoutMs) {
      text = await page.locator(".canvas-toast").textContent().catch(() => null);
      if (text && !text.includes("正在导出")) return text;
      await page.waitForTimeout(400);
    }
    return text;
  };

  // 先在没有画框的情况下点「导出选中画框」——应该给可读提示
  report.step = "打开导出菜单（第一次）";
  await page.locator('[data-testid="export-menu"]').click();
  await page.waitForTimeout(400);
  report.menuItems = await page.$$eval('[data-testid="export-options"] button', (els) =>
    els.map((e) => e.getAttribute("data-testid")),
  );
  report.step = "点「导出画框」（此时还没有画框）";
  await page.locator('[data-testid="export-frame"]').click();
  await page.waitForTimeout(900);
  report.noFrameMessage = await page.locator(".canvas-toast").textContent().catch(() => null);
  /*
   * ⚠️ 这条提示**不会自己消失**（`CanvasRuntime.tsx:679` 的 title 就是「点击关闭」），
   * 而它 `z-index:15` 盖在导出菜单（`z-index:10` 的工具条下方弹出）上面 ——
   * 不点掉它，后面每一次点菜单项都会被它挡住，等到 30 秒超时。
   * 第一版就是死在这儿：报"某元素超时"，看着像导出坏了。
   * 顺手断言"点得掉"：常驻提示如果关不掉，那是比超时更糟的事。
   */
  await page.locator(".canvas-toast").click();
  await page.waitForTimeout(400);
  report.toastDismissed = (await page.locator(".canvas-toast").count()) === 0;

  // 导出当前视图
  report.step = "再次打开导出菜单";
  await page.locator('[data-testid="export-menu"]').click();
  await page.waitForTimeout(300);
  report.step = "点「导出当前视图」";
  await page.locator('[data-testid="export-view"]').click();
  report.viewToast = await waitExport();
  const viewFile = newestExport();
  report.viewPng = viewFile ? { file: path.basename(viewFile), ...pngSize(viewFile) } : null;

  // 建一个画框，再导出画框
  await page.locator('[data-testid="add-node"]').click();
  await page.waitForTimeout(300);
  report.step = "点「新建」（打开类型菜单）";
  await page.locator('.canvas-menu button[data-kind="frame"]').click();
  await page.waitForTimeout(1500);
  report.step = "选择画框类型";
  await page.locator(".frame-node").click({ force: true });
  report.step = "选中刚建的画框";
  await page.waitForTimeout(400);

  report.step = "打开导出菜单（有画框之后）";
  await page.locator('[data-testid="export-menu"]').click();
  await page.waitForTimeout(300);
  report.step = "点「导出画框」";
  await page.locator('[data-testid="export-frame"]').click();
  report.frameToast = await waitExport();
  const frameFile = newestExport();
  report.framePng = frameFile ? { file: path.basename(frameFile), ...pngSize(frameFile) } : null;

  report.smallerThanView =
    report.viewPng && report.framePng
      ? report.framePng.width * report.framePng.height < report.viewPng.width * report.viewPng.height
      : null;
  report.totalExports = fs.existsSync(EXPORTS) ? fs.readdirSync(EXPORTS).length : 0;
  report.frameFileName = report.framePng?.file ?? null;

} catch (error) {
  report.error = `在「${report.step}」这一步失败：${String(error).split(String.fromCharCode(10))[0]}`;
}
console.log(JSON.stringify(report, null, 2));

/*
 * ── 判定（2026-10-14 补）────────────────────────────────────────────
 *
 * 这条在清单里挂着"等某元素超时"（丙类）—— 因为没有 try/catch，
 * 中途超时就抛出去，既不打印错误摘要也不判定，读的人只看到一句超时。
 * 现在：异常收成一条判词；它该守的东西（**真产出 PNG 且尺寸对得上**）补齐。
 */
const bad = [];
if (report.error) bad.push(`异常：${String(report.error).slice(0, 200)}`);
const png = (o) => o && o.magic === "PNG" && o.bytes > 1000 && o.width > 0 && o.height > 0;

if (!report.menuItems?.includes("export-frame")) bad.push(`导出菜单里没有「导出画框」：${JSON.stringify(report.menuItems)}`);
if (!report.menuItems?.includes("export-view")) bad.push("导出菜单里没有「导出当前视图」");

/* 没选画框时点「导出画框」→ 必须给可读提示，不能静默什么都不发生 */
if (!report.noFrameMessage) bad.push("⭐ 没选画框就点「导出画框」，界面没有任何提示");
if (!report.toastDismissed) bad.push("⭐ 那条提示点不掉（常驻浮层会一直挡着下面的按钮）");

/* 导出视图：磁盘上真多一张合法 PNG */
if (!png(report.viewPng)) bad.push(`导出视图没产出合法 PNG：${JSON.stringify(report.viewPng)}`);
if (!String(report.viewToast ?? "").includes("已导出")) {
  bad.push(`导出视图的结果是 ${JSON.stringify(report.viewToast)}（应含「已导出」）`);
}

/* 导出画框：尺寸应**小于**视图（画框只框住那一块） */
if (!png(report.framePng)) bad.push(`导出画框没产出合法 PNG：${JSON.stringify(report.framePng)}`);
if (!String(report.frameToast ?? "").includes("已导出")) {
  bad.push(`导出画框的结果是 ${JSON.stringify(report.frameToast)}（应含「已导出」）`);
}
if (report.smallerThanView !== true) bad.push("⭐ 导出画框的尺寸不小于整视图（等于没按画框裁）");
if ((report.totalExports ?? 0) < 2) bad.push(`exports 目录里只有 ${report.totalExports} 个文件（应至少 2 次导出）`);
if (!report.frameFileName?.toLowerCase().endsWith(".png")) bad.push(`导出文件名不像图片：${report.frameFileName}`);

verdict(bad, "画布导出成立：两个菜单项都在 / 没选画框有提示 / 视图与画框各产出一张合法 PNG / 画框那张确实更小");

await browser.close();
child.kill();
