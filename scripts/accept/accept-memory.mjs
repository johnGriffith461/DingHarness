import { chromium } from "playwright";
import { spawn } from "node:child_process";
import path from "node:path";
import { connectWithRetry, freshDir, killTree, pickPort, readStoreFile, shot, waitForPort } from "./harness.mjs";

/**
 * 验收：记忆（对应本体 `chat/memory/list|clear|delete`）。
 *
 * 走真实路径：账号菜单 → 设置 → 点「记忆」→ 加一条 → **刷新** → 还在 → 删掉。
 * 重点是**刷新后还在** —— "加完能用、重启就没了"是这个项目犯过的错（§49）。
 */
const DATA = "D:/DoubaoWorkClone/.verify/mem-data";
// 先杀残留再删：Windows 上被句柄占着的目录会报 EPERM（§135 撞过）。
if (!(await freshDir(DATA))) {
  console.error("✗ 数据目录 " + DATA + " 删不掉 —— 先手工关掉占着它的 Electron");
  process.exit(1);
}
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
env.DSH_CANVAS_DATA_DIR = DATA;

/* 这台机器的回环端口会随机连不上（见 harness.pickPort）→ 起之前先挑一个能用的。 */
const __port = await pickPort([12994]);
/* 应用只认这个环境变量（命令行那个在打包产物里会被忽略）—— 两处必须是同一个端口。 */
env.DSH_DEBUG_PORT = String(__port);
const child = spawn("D:/DoubaoWorkClone/node_modules/electron/dist/electron.exe", [".", "--remote-debugging-port=" + __port], {
  cwd: "D:/DoubaoWorkClone",
  env,
  stdio: ["ignore", "ignore", "ignore"],
});

const out = {};
const openSettings = async (page) => {
  await page.locator('[data-testid="wb-account"]').click();
  await page.waitForTimeout(600);
  await page.locator('[data-testid="wb-acct-settings"]').click();
  await page.waitForTimeout(800);
};

/* 固定等 13 秒会在机器忙时不够（应用还没监听）→ 改成轮询端口：实测过的失败形态是 `ECONNREFUSED`（= 什么都没在听，不是端口坏）。 */
await waitForPort(__port, 40000);
let browser;
try {
  browser = await connectWithRetry(chromium, "http://127.0.0.1:" + __port);
  const page = browser.contexts()[0].pages().find((p) => !p.url().startsWith("devtools://"));
  await page.waitForSelector('[data-testid="wb"]', { timeout: 20000 });
  await page.waitForTimeout(2200);

  await openSettings(page);

  // 那一行应该已经**不再禁用**，且显示"暂无"
  out.rowDisabled = await page.evaluate(() => {
    const el = document.querySelector('[data-testid="wb-set-记忆"]');
    return el ? el.hasAttribute("disabled") : null;
  });
  out.rowValue = await page.evaluate(
    () => document.querySelector('[data-testid="wb-set-记忆"]')?.textContent?.trim() ?? null,
  );

  await page.locator('[data-testid="wb-set-记忆"]').click();
  await page.waitForTimeout(700);
  out.panelOpen = (await page.locator('[data-testid="wb-memory"]').count()) === 1;

  await page.locator('[data-testid="wb-memory-input"]').fill("回答尽量简短，别用客套话");
  await page.locator('[data-testid="wb-memory-add"]').click();
  await page.waitForTimeout(900);
  out.afterAdd = await page.evaluate(() => ({
    items: document.querySelectorAll(".wb-memory-item").length,
    text: document.querySelector(".wb-memory-text")?.textContent ?? null,
  }));

  /*
   * ⚠️ 2026-10-13 补：`wb-memory-list` / `wb-memory-item-*` / `wb-memory-clear` 这三个 testid
   * **原来没有任何脚本引用过**（`src/` × `scripts/accept/` 交叉，见 HANDOFF §208 的零覆盖清单）。
   * 上面数的是 `.wb-memory-item`（class），**列表容器本身**没人看过 —— 容器没渲染、行悬空
   * 也不会红。先钉住容器与行的对应关系。
   */
  out.listBox = await page.locator('[data-testid="wb-memory-list"]').count();
  out.listItems = await page.locator('[data-testid^="wb-memory-item-"]').count();

  // 刷新 —— 关键一步
  await page.reload();
  await page.waitForSelector('[data-testid="wb"]', { timeout: 20000 });
  await page.waitForTimeout(2500);
  await openSettings(page);
  out.afterReloadRowValue = await page.evaluate(
    () => document.querySelector('[data-testid="wb-set-记忆"]')?.textContent?.trim() ?? null,
  );
  await page.locator('[data-testid="wb-set-记忆"]').click();
  await page.waitForTimeout(800);
  out.afterReload = await page.evaluate(() => ({
    items: document.querySelectorAll(".wb-memory-item").length,
    text: document.querySelector(".wb-memory-text")?.textContent ?? null,
  }));

  // 删掉
  const dropId = await page.evaluate(() =>
    document.querySelector('[data-testid^="wb-memory-drop-"]')?.getAttribute("data-testid") ?? null,
  );
  if (dropId) {
    await page.locator(`[data-testid="${dropId}"]`).click();
    await page.waitForTimeout(800);
  }
  out.afterDrop = await page.evaluate(() => ({
    items: document.querySelectorAll(".wb-memory-item").length,
    empty: document.querySelectorAll('[data-testid="wb-memory-empty"]').length,
  }));

  /*
   * ── 「全部清除」要真清（2026-10-13 补，见 §208 零覆盖清单）──
   *
   * 断**后果**（不是"点了没报错"）：再加一条 → 点「全部清除」→ 界面空 + **磁盘也空**
   * （这条 store 是"先改本地再落盘"，所以两边都要看）。
   */
  await page.locator('[data-testid="wb-memory-input"]').fill("第二条：以后叫我老板");
  await page.locator('[data-testid="wb-memory-add"]').click();
  await page.waitForTimeout(900);
  out.beforeClear = await page.locator('[data-testid^="wb-memory-item-"]').count();
  if (out.beforeClear > 0) {
    await page.locator('[data-testid="wb-memory-clear"]').click();
    await page.waitForTimeout(1200);
  }
  out.afterClear = await page.evaluate(() => ({
    items: document.querySelectorAll('[data-testid^="wb-memory-item-"]').length,
    empty: document.querySelectorAll('[data-testid="wb-memory-empty"]').length,
  }));
  out.diskAfterClear = (() => {
    try {
      const d = readStoreFile(path.join(DATA, "memory.json"));
      return Array.isArray(d?.entries) ? d.entries.length : Array.isArray(d) ? d.length : null;
    } catch {
      return null;
    }
  })();

  // 截图是留给人看的证据，不是判定依据 —— 偶发超时不该把功能全过的验收拖红。
  out.shot = await shot(page, "memory.png");
  await browser.close();
} catch (e) {
  out.error = String(e).slice(0, 220);
} finally {
  console.log(JSON.stringify(out, null, 2));
  await killTree(child);
  const bad = [];
  if (out.rowDisabled !== false) bad.push("「记忆」那一行还是禁用的");
  if (!out.panelOpen) bad.push("面板没打开");
  if ((out.afterAdd?.items ?? 0) !== 1) bad.push("加完没有 1 条");
  if ((out.afterReload?.items ?? 0) !== 1) bad.push("刷新后丢了（关键）");
  if ((out.afterDrop?.items ?? -1) !== 0) bad.push("删完还剩");

  /* 补的那组（零覆盖清单里的列表容器 / 行 / 全部清除，§208） */
  if (out.listBox !== 1) bad.push("记忆面板里没有列表容器（wb-memory-list）");
  if (out.listItems !== 1) bad.push(`加完列表里应有 1 行，实际 ${out.listItems}`);
  if (out.beforeClear !== 1) bad.push(`「全部清除」之前应当有 1 条，实际 ${out.beforeClear}`);
  if ((out.afterClear?.items ?? -1) !== 0) bad.push(`点了「全部清除」列表里还剩 ${out.afterClear?.items} 条`);
  if ((out.afterClear?.empty ?? 0) !== 1) bad.push("全部清除之后没有回到空态");
  if (out.diskAfterClear !== 0) bad.push(`⭐ 全部清除没落盘（磁盘上还有 ${out.diskAfterClear} 条）`);
  if (out.error) bad.push("异常: " + out.error);
  if (bad.length) {
    console.error("✗ " + bad.join("；"));
    process.exitCode = 1;
  } else {
    console.log("✓ 记忆可用且刷新后仍在");
  }
}
