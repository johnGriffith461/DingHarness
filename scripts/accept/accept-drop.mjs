import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";
import { NO_PAGE_HINT, bootApp, connectWithRetry, freshDir, killTree, shot, waitForPage } from "./harness.mjs";

/**
 * 验收：**拖拽上传**（§171）+ **上传面板的逐条状态**（补 §170 没验成的那半边）。
 *
 * ## 这条**不调模型**（进批跑）
 *
 * 拖进来的文件在渲染进程里是 `File` 对象 —— 造一个**真的** `File`（带内容）
 * 就能走完 `importData` 那条路，于是**面板会真的亮起来**。
 * §170 那条验收只能摸主进程（系统文件框点不了），这一条把界面上那半边补上。
 *
 * 五条断言：
 * ① 拖进去一个 `.md` → **真的落进 `drive/`**，内容一字不差
 * ② ⭐ **面板出现了**，那一行写着 `已完成`
 * ③ ⭐ 汇总那句是证据里的形状：`已上传 1 个，0 个上传失败`
 * ④ 再拖一个 `.exe` → 那一行是 `解析失败（暂不支持该文件类型）`，**且它没落盘**
 * ⑤ 拖进来时角标出现、拖出去（dragleave）角标消失
 */
const DATA = ".verify/drop-data";
if (!(await freshDir(DATA))) {
  console.error("✗ 数据目录 " + DATA + " 删不掉 —— 先手工关掉占着它的 Electron");
  process.exit(1);
}
fs.mkdirSync(path.join(DATA, "drive"), { recursive: true });

const PORT = 9323;
const out = {};
let child = null;
let ok = false;
let getLog = () => "";

const boot = async () => {
  const r = await bootApp({ port: PORT, dataDir: DATA, timeoutMs: 30000 });
  child = r.child;
  ok = r.ok;
  getLog = r.getLog;
  return ok;
};

/**
 * 造一个带内容的 File 并把它"拖"进拖拽区。
 *
 * ⚠️ 分两步做：先 `dragenter`，**等一次重渲染**再读角标 ——
 * `setDragDepth` 是异步的，派发完立刻读 DOM 一定读不到（第一版就是这么误判的）。
 */
const dragEnter = (page, name, text) =>
  page.evaluate(
    async ([n, txt]) => {
      const el = document.querySelector('[data-testid="wb-cloud-drop"]');
      if (!el) return { error: "没有拖拽区" };
      const dt = new DataTransfer();
      dt.items.add(new File([txt], n, { type: "text/plain" }));
      el.dispatchEvent(new DragEvent("dragenter", { bubbles: true, dataTransfer: dt }));
      return { ok: true };
    },
    [name, text],
  );

/** 真的落下。 */
const dropNow = (page, name, text) =>
  page.evaluate(
    async ([n, txt]) => {
      const el = document.querySelector('[data-testid="wb-cloud-drop"]');
      const dt = new DataTransfer();
      dt.items.add(new File([txt], n, { type: "text/plain" }));
      el.dispatchEvent(new DragEvent("dragover", { bubbles: true, dataTransfer: dt }));
      el.dispatchEvent(new DragEvent("drop", { bubbles: true, dataTransfer: dt }));
      return { ok: true };
    },
    [name, text],
  );

const drop = async (page, name, text) => {
  await dragEnter(page, name, text);
  await page.waitForTimeout(350);
  const hintAfterEnter = await page.evaluate(() => Boolean(document.querySelector(".wb-cloud-drop-hint")));
  await dropNow(page, name, text);
  return { hintAfterEnter };
};

try {
  if (!(await boot())) {
    console.error("[诊断] 应用输出尾部：\n" + (getLog() || "(空)").slice(-1200));
    await killTree(child);
    process.exit(1);
  }

  const b = await connectWithRetry(chromium, `http://127.0.0.1:${PORT}`);
  const page = await waitForPage(b);
  if (!page) throw new Error(NO_PAGE_HINT);
  await page.waitForSelector('[data-testid="wb"]', { timeout: 20000 });

  await page.locator('[data-testid="wb-nav-cloud"]').click();
  await page.waitForTimeout(1800);
  out.hasDropZone = (await page.locator('[data-testid="wb-cloud-drop"]').count()) > 0;

  const BODY = "# 拖进来的东西\n\n面板该亮起来。\n";

  /* ① 拖一个正常的 .md */
  const first = await drop(page, "拖进来的.md", BODY);
  out.hintAfterEnter = first.hintAfterEnter;
  await page.waitForTimeout(2500);
  out.disk1 = fs.readdirSync(path.join(DATA, "drive")).sort();
  out.fileBody = fs.existsSync(path.join(DATA, "drive", "拖进来的.md"))
    ? fs.readFileSync(path.join(DATA, "drive", "拖进来的.md"), "utf8")
    : null;

  /* ②③ 面板与那一行 */
  out.panelShown = (await page.locator('[data-testid="wb-upload-panel"]').count()) > 0;
  out.sum1 = await page.evaluate(
    () => document.querySelector('[data-testid="wb-upload-sum"]')?.textContent?.trim() ?? "",
  );
  out.row1 = await page.evaluate(
    () => document.querySelector('[data-testid="wb-upload-row-拖进来的.md"]')?.textContent?.replace(/\\s+/g, " ").trim() ?? "",
  );

  /* 角标拖出去要消失 */
  await page.evaluate(() => {
    const el = document.querySelector('[data-testid="wb-cloud-drop"]');
    el?.dispatchEvent(new DragEvent("dragleave", { bubbles: true }));
  });
  await page.waitForTimeout(400);
  out.hintAfterLeave = await page.evaluate(() => Boolean(document.querySelector(".wb-cloud-drop-hint")));

  /*
   * ── ②b 列表本身 / 收起 / 关闭（2026-10-13 补）──
   *
   * ⚠️ `wb-upload-list` / `wb-upload-collapse` / `wb-upload-close` 这三个 testid
   * **原来没有任何脚本引用过**（`src/` × `scripts/accept/` 交叉，见 HANDOFF §208 的零覆盖清单）。
   * 上面那两条断的是"行文案"，**列表容器本身**没人看过 —— 面板被做烂（比如挤塌、列表是空的）
   * 也不会有脚本红。所以这里断**后果**：
   *   · 列表在，且里面**行数与面板上的条数一致**；
   *   · 点「收起」→ 列表真的收起来（`wb-upload-list` 消失）且按钮变成「展开」；
   *   · 再点「展开」→ 列表回来（不是单向的死按钮）。
   */
  out.uploadList = await page.evaluate(() => {
    const box = document.querySelector('[data-testid="wb-upload-list"]');
    return {
      count: box ? 1 : 0,
      rows: box ? box.querySelectorAll('[data-testid^="wb-upload-row-"]').length : 0,
    };
  });
  await page.locator('[data-testid="wb-upload-collapse"]').click();
  await page.waitForTimeout(400);
  out.collapsedList = await page.locator('[data-testid="wb-upload-list"]').count();
  out.collapseTitle = await page.evaluate(
    () => document.querySelector('[data-testid="wb-upload-collapse"]')?.getAttribute("title") ?? "",
  );
  await page.locator('[data-testid="wb-upload-collapse"]').click();
  await page.waitForTimeout(400);
  out.expandedAgain = await page.locator('[data-testid="wb-upload-list"]').count();

  /* ④ 拖一个 .exe */
  await drop(page, "某个程序.exe", "MZ...");
  await page.waitForTimeout(2500);
  out.disk2 = fs.readdirSync(path.join(DATA, "drive")).sort();
  out.sum2 = await page.evaluate(
    () => document.querySelector('[data-testid="wb-upload-sum"]')?.textContent?.trim() ?? "",
  );
  out.row2 = await page.evaluate(
    () => document.querySelector('[data-testid="wb-upload-row-某个程序.exe"]')?.textContent?.replace(/\\s+/g, " ").trim() ?? "",
  );

  /*
   * ── ⑤ 「关闭」要真把面板收掉（2026-10-13 补，见 §208 零覆盖清单）──
   * 断**后果**：点完面板整个消失（`shouldShowPanel` 变 false）——不是"点了没报错"。
   * 放在截图之后：截图留给人的是**两条都在**的那一屏。
   */
  out.shot = await shot(page, "drop.png");
  await page.locator('[data-testid="wb-upload-close"]').click();
  await page.waitForTimeout(600);
  out.panelGoneAfterClose = (await page.locator('[data-testid="wb-upload-panel"]').count()) === 0;

  await b.close();
} catch (e) {
  out.error = String(e).slice(0, 300);
} finally {
  console.log(JSON.stringify(out, null, 2));
  await killTree(child);

  const bad = [];
  if (out.error) bad.push("异常: " + out.error);

  if (!out.hasDropZone) bad.push("云盘页没有拖拽区");

  /* ① 内容一字不差 */
  if (!(out.disk1 ?? []).includes("拖进来的.md")) bad.push(`拖进来的文件没落盘：${JSON.stringify(out.disk1)}`);
  if (out.fileBody !== "# 拖进来的东西\n\n面板该亮起来。\n") {
    bad.push(`落盘内容不对：${JSON.stringify(out.fileBody)}`);
  }

  /* ②③ 面板与文案 */
  if (!out.panelShown) bad.push("⭐ 上传之后面板没出现（§170 没验成的那半边）");
  if (out.sum1 !== "已上传 1 个，0 个上传失败") bad.push(`汇总那句不对：${out.sum1}`);
  if (!(out.row1 ?? "").includes("已完成")) bad.push(`那一行没写「已完成」：${out.row1}`);

  /* 角标 */
  if (!out.hintAfterEnter) bad.push("拖进来时没有角标");
  if (out.hintAfterLeave) bad.push("拖出去之后角标还在（dragleave 没清干净）");

  /* ②b 列表 / 收起 / 展开 / 关闭（零覆盖清单那一组，§208） */
  if (out.uploadList?.count !== 1) bad.push("上传面板里没有列表容器");
  if (out.uploadList?.rows !== 1) bad.push(`列表里应有 1 行，实际 ${out.uploadList?.rows}`);
  if (out.collapsedList !== 0) bad.push("点了「收起」列表没收起来");
  if (out.collapseTitle !== "展开") bad.push(`收起之后那颗按钮该变成「展开」，实际「${out.collapseTitle}」`);
  if (out.expandedAgain !== 1) bad.push("再点一次「展开」列表没回来（单向的死按钮）");
  if (!out.panelGoneAfterClose) bad.push("点了「关闭」面板还在（没真收掉）");

  /* ④ 被拒的那种 */
  if (!(out.row2 ?? "").includes("解析失败")) bad.push(`被拒那行没写解析失败：${out.row2}`);
  if (!(out.row2 ?? "").includes("暂不支持该文件类型")) bad.push(`被拒那行没带原因：${out.row2}`);
  if ((out.disk2 ?? []).includes("某个程序.exe")) bad.push("⭐ .exe 竟然落盘了");

  if (bad.length) {
    console.error("✗ " + bad.join("；"));
    process.exitCode = 1;
  } else {
    console.log("✓ 拖拽上传成立：内容落盘一字不差 / 面板亮起且逐条状态对 / .exe 被拒且没落盘 / 角标进出都干净");
  }
}
