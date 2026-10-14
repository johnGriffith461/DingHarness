import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";
import { NO_PAGE_HINT, bootApp, connectWithRetry, freshDir, killTree, shot, waitForPage } from "./harness.mjs";

/**
 * 验收：**云盘的下载 / 另存为**（§169，对应 `drive_menuOption_download`）。
 *
 * ## 这条**不调模型**（进批跑）
 *
 * 五条断言：
 * ① 右键菜单里有「下载」（逐字）
 * ② ⭐ **指定目标目录时真的把文件复制过去**（字节一模一样）—— 这条路不弹框，能确定性验
 * ③ ⭐ **白名单外的路径必须被拒** —— 否则这里就成了"任意文件读出"
 * ④ 不存在的文件返回失败（**不是**"已取消"：两者界面上的话不一样）
 * ⑤ 三句话各有各的（已下载到本地 / 下载已取消 / 下载失败，请重试）—— 由单测覆盖，这里顺带读一眼文案
 *
 * ⚠️ 没验"弹系统另存为框"那条路：框不是自动化能点的东西，
 * 这里只保证**它与静默复制共用同一段复制逻辑**（都在 `drive:download` 里）。
 */
const DATA = ".verify/download-data";
if (!(await freshDir(DATA))) {
  console.error("✗ 数据目录 " + DATA + " 删不掉 —— 先手工关掉占着它的 Electron");
  process.exit(1);
}
const DIR = path.join(DATA, "drive");
const ARTIFACTS = path.join(DATA, "artifacts");
fs.mkdirSync(DIR, { recursive: true });
fs.mkdirSync(ARTIFACTS, { recursive: true });

const BODY = "# 季度复盘\n\n本季度完成三件事。\n";
fs.writeFileSync(path.join(DIR, "季报.md"), BODY, "utf8");
fs.writeFileSync(path.join(ARTIFACTS, "产物.md"), "# 产物\n", "utf8");
/** 白名单**外**的一个文件（就在数据目录根部）。 */
const OUTSIDE = path.join(DATA, "在外面.md");
fs.writeFileSync(OUTSIDE, "# 不该被下载出去\n", "utf8");

const TARGET = path.join(DATA, "另存的去处");

const PORT = 9321;
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

  const b = await connectWithRetry(chromium, `http://127.0.0.1:${PORT}`);
  const page = await waitForPage(b);
  if (!page) throw new Error(NO_PAGE_HINT);
  await page.waitForSelector('[data-testid="wb"]', { timeout: 20000 });

  await page.locator('[data-testid="wb-nav-cloud"]').click();
  await page.waitForTimeout(2000);

  /* ① 菜单项 */
  await page.locator('[data-testid="wb-file-季报.md"]').click({ button: "right" });
  await page.waitForTimeout(600);
  out.menuLabels = await page.evaluate(() =>
    Array.from(document.querySelectorAll('[data-testid^="wb-drive-menu-"]')).map((e) =>
      (e.getAttribute("data-testid") ?? "").replace("wb-drive-menu-", ""),
    ),
  );
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);

  /* ②③④ 直接调桥（静默复制那条路） */
  const call = (filePath, targetDir) =>
    page.evaluate(
      async ([p, t]) => {
        const shell = window.shell;
        if (!shell?.drive?.download) return { ok: false, error: "桥不可用" };
        return await shell.drive.download(p, t);
      },
      [filePath, targetDir],
    );

  out.copyIn = await call(path.join(DIR, "季报.md"), TARGET);
  out.copied = fs.existsSync(path.join(TARGET, "季报.md")) ? fs.readFileSync(path.join(TARGET, "季报.md"), "utf8") : null;
  out.copyArtifact = await call(path.join(ARTIFACTS, "产物.md"), TARGET);

  out.outsideAttempt = await call(OUTSIDE, TARGET);
  out.outsideCopied = fs.existsSync(path.join(TARGET, "在外面.md"));

  out.missing = await call(path.join(DIR, "根本不存在.md"), TARGET);

  out.shot = await shot(page, "download.png");
  await b.close();
} catch (e) {
  out.error = String(e).slice(0, 300);
} finally {
  console.log(JSON.stringify(out, null, 2));
  await killTree(child);

  const bad = [];
  if (out.error) bad.push("异常: " + out.error);

  if (!(out.menuLabels ?? []).includes("下载")) bad.push(`右键菜单里没有「下载」：${JSON.stringify(out.menuLabels)}`);

  /* ② 真的复制过去了，而且字节一样 */
  if (!out.copyIn?.ok) bad.push(`指定目录下载失败了：${JSON.stringify(out.copyIn)}`);
  if (out.copied !== BODY) bad.push(`复制过去的文件内容不对：${JSON.stringify(out.copied)}`);
  if (!out.copyArtifact?.ok) bad.push("产物目录里的文件下载失败（它也在白名单里）");

  /* ③ 白名单边界 */
  if (out.outsideAttempt?.ok) bad.push("⭐ 白名单外的文件竟然被下载出去了（这是任意文件读）");
  if (out.outsideCopied) bad.push("⭐ 白名单外的文件真的落到了目标目录里");

  /* ④ 不存在 → 失败，但不是"已取消" */
  if (out.missing?.ok) bad.push("不存在的文件竟然返回成功");
  if (out.missing?.canceled) bad.push("不存在的文件被报成了「已取消」（两者界面上的话不一样）");

  if (bad.length) {
    console.error("✗ " + bad.join("；"));
    process.exitCode = 1;
  } else {
    console.log("✓ 云盘下载成立：菜单有「下载」/ 指定目录真复制且字节一致 / 白名单外被拒 / 不存在报失败而非取消");
  }
}
