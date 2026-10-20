import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";
import {
  NO_PAGE_HINT,
  bootApp,
  connectWithRetry,
  freshDir,
  killTree,
  shot,
  waitForPage,
} from "./harness.mjs";

/**
 * F-02（2026-10-20）：**设置 → 通用 → 工作目录**。
 *
 * ## 它挡的是什么
 *
 * 首跑向导写着"工作目录可以跳过，之后在设置里加"，而设置里**根本没有那一格** ——
 * 这句承诺是假的。入口原来只在输入区的「更多」弹层里。
 *
 * ## 怎么验（不弹系统目录选择器）
 *
 * `workspace:add` 只认系统对话框的返回（渲染层不能传路径 —— 那是安全边界）。
 * 所以这里走 `workspaceStore.ts` 自己写明的验收口径：**预置 `workspaces.json`**
 * 等价于"用户点过选择器"，然后验两件事：
 * 1. 授权之后 `runTool(read_file)` **真的读得到**那个目录里的文件；
 * 2. 在设置里点「撤销」之后，同一次调用**立刻读不到**，错误里带共享话术。
 *
 * 添加按钮本身只断言"存在且可点"（系统对话框不是 Playwright 能驱动的）。
 */

const DATA = ".verify/workspace-settings-data";
const DIR = path.resolve(".verify/workspace-settings-allowed");
const FILE = path.join(DIR, "hello.txt");
const MARKER = "workspace-settings-probe";

if (!(await freshDir(DATA))) {
  console.error("✗ 数据目录 " + DATA + " 删不掉 —— 先手工关掉占着它的 Electron");
  process.exit(1);
}
fs.mkdirSync(DATA, { recursive: true });
fs.rmSync(DIR, { recursive: true, force: true });
fs.mkdirSync(DIR, { recursive: true });
fs.writeFileSync(FILE, MARKER, "utf8");
/* 预置授权列表（与"用户在对话框里选了这个目录"等价的落盘形状；C1 信封） */
fs.writeFileSync(
  path.join(DATA, "workspaces.json"),
  JSON.stringify({ __schema: 1, data: { dirs: [DIR] } }, null, 2),
  "utf8",
);

const PORT = 9382;
const out = {};
let child = null;

try {
  const booted = await bootApp({ port: PORT, dataDir: DATA, timeoutMs: 30000 });
  child = booted.child;
  if (!booted.ok) {
    console.error("[诊断] 应用输出尾部：\n" + (booted.getLog() || "(空)").slice(-1200));
    process.exit(1);
  }
  const browser = await connectWithRetry(chromium, `http://127.0.0.1:${PORT}`);
  const page = await waitForPage(browser);
  if (!page) throw new Error(NO_PAGE_HINT);
  await page.waitForSelector('[data-testid="wb"]', { timeout: 20000 });
  await page.waitForTimeout(1200);

  /* 授权之后：runTool 读得到 */
  const before = await page.evaluate(async (file) => {
    const got = await window.shell.ai.runTool({ name: "read_file", input: { path: file } });
    return { ok: got.ok, error: got.error ?? "", line: got.line, output: JSON.stringify(got.output ?? "").slice(0, 300) };
  }, FILE);
  out.readBefore = before;
  out.readBeforeOk = before.ok === true && before.output.includes(MARKER);

  /* 设置 → 通用 → 工作目录 */
  await page.locator('[data-testid="wb-account"]').click();
  await page.waitForTimeout(300);
  await page.locator('[data-testid="wb-acct-settings"]').click();
  await page.waitForTimeout(500);
  await page.locator('[data-testid="wb-set-通用"]').click();
  await page.waitForTimeout(700);
  out.settingsBlockVisible = (await page.locator('[data-testid="wb-workspace-settings"]').count()) === 1;
  out.rowVisible = (await page.locator('[data-testid="wb-workspace-row-workspace-settings-allowed"]').count()) === 1;
  out.addButtonEnabled = await page.locator('[data-testid="wb-workspace-add"]').isEnabled().catch(() => false);
  out.hintVisible = (await page.locator('[data-testid="wb-workspace-hint"]').innerText().catch(() => "")).includes(
    "设置 → 通用 → 工作目录",
  );
  await shot(page, ".verify/workspace-settings.png");

  /* 撤销 */
  await page.locator('[data-testid="wb-workspace-remove-workspace-settings-allowed"]').click();
  await page.waitForTimeout(900);
  out.rowGone = (await page.locator('[data-testid="wb-workspace-row-workspace-settings-allowed"]').count()) === 0;
  out.note = await page.locator('[data-testid="wb-workspace-note"]').innerText().catch(() => "");

  /* 撤销之后：同一次 runTool 读不到，且错误里是那句统一话术 */
  const after = await page.evaluate(async (file) => {
    const got = await window.shell.ai.runTool({ name: "read_file", input: { path: file } });
    return { ok: got.ok, error: got.error ?? "", line: got.line };
  }, FILE);
  out.readAfter = after;
  out.readAfterBlocked = after.ok === false && after.error.includes("设置 → 通用 → 工作目录");

  await browser.close();
} catch (error) {
  out.error = error instanceof Error ? error.message : String(error);
} finally {
  await killTree(child);
}

const checks = [
  ["设置 → 通用里有「工作目录」这一块", out.settingsBlockVisible === true],
  ["已授权目录列出来了（不是空表）", out.rowVisible === true],
  ["「授权一个目录」按钮可点", out.addButtonEnabled === true],
  ["说明指向 设置 → 通用 → 工作目录", out.hintVisible === true],
  ["授权时 runTool(read_file) 真的读得到", out.readBeforeOk === true],
  ["点「撤销」之后那一行消失", out.rowGone === true],
  ["撤销之后同一次调用立刻读不到", out.readAfterBlocked === true],
];

if (out.error) process.stdout.write(`\n异常：${out.error}\n`);
let failed = 0;
for (const [name, ok] of checks) {
  if (!ok) failed += 1;
  process.stdout.write(`${ok ? "✓" : "✗"} ${name}\n`);
}
process.stdout.write("\n" + JSON.stringify(out, null, 2) + "\n");
process.stdout.write(`\n${failed === 0 ? "✓ 全部通过" : `✗ ${failed} 项未通过`}（${checks.length} 项：工作目录管理）\n`);
process.exit(failed === 0 ? 0 : 1);
