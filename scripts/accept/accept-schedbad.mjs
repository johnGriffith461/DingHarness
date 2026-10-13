import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";
import { NO_PAGE_HINT, bootApp, freshDir, killTree, shot, waitForPage } from "./harness.mjs";

/**
 * 验收：**坏了/旧了的定时任务文件不许把界面带崩**（§178）。
 *
 * ## 这条**不调模型**（进批跑）
 *
 * 种一个"半坏"的 `schedules.json`：
 * - 一条**正常**的（该照常跑）
 * - 一条 `status` 是别的词的（→ 应当显示**已暂停**，绝不能自己跑起来）
 * - 一条 `repeat` 不认识的（→ 算不出下次运行时间，应当**丢掉**）
 * - 一条没有 `id` 的（→ 管不了，应当**丢掉**）
 * - 一条 `nextRunAt` 是字符串的（→ 应当不显示 Invalid Date）
 *
 * ⚠️ 关键是**页面照常打开**：原来这里是一句 `as CronJob[]` 直接断言，
 * 坏字段会一路带到界面与 ticker 里。
 */
const DATA = "D:/DoubaoWorkClone/.verify/schedbad-data";
if (!(await freshDir(DATA))) {
  console.error("✗ 数据目录 " + DATA + " 删不掉 —— 先手工关掉占着它的 Electron");
  process.exit(1);
}
fs.mkdirSync(DATA, { recursive: true });

const FUTURE = Date.now() + 3_600_000;
fs.writeFileSync(
  path.join(DATA, "schedules.json"),
  JSON.stringify(
    [
      {
        id: "j-good",
        title: "每日新闻",
        prompt: "跑一下",
        repeat: "daily",
        env: "cloud",
        status: "running",
        createdAt: Date.now() - 1000,
        lastRunAt: null,
        nextRunAt: FUTURE,
        runs: [],
      },
      { ...{ id: "j-badstatus", title: "状态坏了" }, repeat: "daily", status: "什么状态", nextRunAt: FUTURE, runs: [] },
      { id: "j-badrepeat", title: "重复方式坏了", prompt: "x", repeat: "每小时", status: "running", nextRunAt: FUTURE, runs: [] },
      { title: "没有 id 的", prompt: "x", repeat: "daily", status: "running", nextRunAt: FUTURE, runs: [] },
      { id: "j-badtime", title: "时间坏了", prompt: "x", repeat: "daily", status: "running", nextRunAt: "明天", runs: [] },
    ],
    null,
    2,
  ),
  "utf8",
);

const PORT = 9330;
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

try {
  if (!(await boot())) {
    console.error("[诊断] 应用输出尾部：\n" + (getLog() || "(空)").slice(-1200));
    await killTree(child);
    process.exit(1);
  }

  const b = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
  const page = await waitForPage(b);
  if (!page) throw new Error(NO_PAGE_HINT);
  await page.waitForSelector('[data-testid="wb"]', { timeout: 20000 });

  /* 定时任务页从左侧导航进（`wb-nav-scheduled`） */
  await page.locator('[data-testid="wb-nav-scheduled"]').click();
  await page.waitForTimeout(1800);

  /*
   * 页面上到底有哪几个任务。
   *
   * ⚠️ 用**状态标记**的 testid 来数（`wb-job-status-<id>` 只出现在真渲染出来的行上），
   * 不要按 `wb-job-` 前缀扫 —— 行上的动作按钮也是这个前缀
   * （`wb-job-edit-<id>` / `wb-job-del-<id>`），会把按钮当成任务（第一版就是这么错的）。
   */
  out.ids = await page.evaluate(() =>
    Array.from(document.querySelectorAll('[data-testid^="wb-job-status-"]')).map((e) =>
      (e.getAttribute("data-testid") ?? "").replace("wb-job-status-", ""),
    ),
  );
  out.statuses = await page.evaluate(() =>
    Object.fromEntries(
      Array.from(document.querySelectorAll('[data-testid^="wb-job-status-"]')).map((e) => [
        (e.getAttribute("data-testid") ?? "").replace("wb-job-status-", ""),
        (e.textContent ?? "").trim(),
      ]),
    ),
  );
  out.pageText = await page.evaluate(() => (document.body.textContent ?? "").replace(/\\s+/g, " ").slice(0, 600));
  out.shot = await shot(page, "schedbad.png");

  await b.close();
} catch (e) {
  out.error = String(e).slice(0, 300);
} finally {
  console.log(JSON.stringify(out, null, 2));
  await killTree(child);

  const bad = [];
  if (out.error) bad.push("异常: " + out.error);

  const ids = out.ids ?? [];

  /* 好的照常在 */
  if (!ids.includes("j-good")) bad.push(`正常那条没显示：${JSON.stringify(ids)}`);
  /* 坏的按口径处置 */
  if (ids.includes("j-badrepeat")) bad.push("⭐ repeat 不认识的那条竟然留下来了（算不出下次运行时间）");
  if (ids.filter((x) => !x.startsWith("j-")).length > 0) {
    bad.push(`⭐ 冒出一条不该存在的任务：${JSON.stringify(ids)}`);
  }
  if (!ids.includes("j-badstatus")) bad.push("status 坏了那条应当留着（只是标成已暂停）");
  if (!ids.includes("j-badtime")) bad.push("时间坏了那条应当留着（时间显示为空即可）");

  if (out.statuses?.["j-badstatus"] !== "已暂停") {
    bad.push(`⭐ status 坏掉那条的显示不对（应当「已暂停」，绝不能是「运行中」）：${out.statuses?.["j-badstatus"]}`);
  }
  if (out.statuses?.["j-good"] !== "运行中") bad.push(`正常那条的状态不对：${out.statuses?.["j-good"]}`);

  /* 不许出现 Invalid Date */
  if ((out.pageText ?? "").includes("Invalid Date")) bad.push("⭐ 界面上出现了 Invalid Date");
  if ((out.pageText ?? "").includes("NaN")) bad.push("⭐ 界面上出现了 NaN");

  if (bad.length) {
    console.error("✗ " + bad.join("；"));
    process.exitCode = 1;
  } else {
    console.log("✓ 坏文件不崩成立：好的照跑 / repeat 坏与无 id 的被丢 / status 坏的标已暂停 / 没有 Invalid Date 与 NaN");
  }
}
