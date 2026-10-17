import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { NO_PAGE_HINT, bootApp, connectWithRetry, freshDir, killTree, shot, waitForPage } from "./harness.mjs";

/**
 * 验收：**L06 个性化**（主题 / 快捷键 / 助手人格）真的生效、真的跨重启。
 *
 * ## 为什么这条要真启应用
 *
 * 三件事都只有真窗口才验得准：
 *   ① 主题 → `<html data-theme>` 与计算样式（单测只能断函数返回值）；
 *   ② 快捷键 → 真按键，看命令面板开没开（源码守卫只能断"用了哪个函数"）；
 *   ③ 人格 → 落盘到 settings.json（假桥不经过主进程，查不出"主进程把它丢了"）。
 *
 * ## 判据（全部是行为）
 *
 * - 通用页里有个性化面板，三块都在；
 * - 选深色 → `data-theme=dark`；重启之后仍是深色；
 * - 录制 Ctrl+J 给命令面板 → 按钮显示 `Ctrl J`、按 Ctrl+J 真的开面板；
 * - 称呼写「主人」→ settings.json 里有 persona.callUser；重启后输入框里还是它。
 */
const DATA = ".verify/personalize-data";
if (!(await freshDir(DATA))) {
  console.error("✗ 数据目录 " + DATA + " 删不掉 —— 先手工关掉占着它的 Electron");
  process.exit(1);
}
const PORT = 9361;
const out = {};
let child = null;

const openSettings = async (page) => {
  await page.locator('[data-testid="wb-account"]').click();
  await page.waitForTimeout(600);
  await page.locator('[data-testid="wb-acct-settings"]').click();
  await page.waitForTimeout(800);
};

const openGeneral = async (page) => {
  await page.locator('[data-testid="wb-set-通用"]').click();
  await page.waitForTimeout(700);
};

const settingsOnDisk = () => {
  /*
   * 设置现在落在 KV（`stores.db` 的 `kv` 表，键名 `settings.json`）——
   * C1 之后 JSON 落盘统一走 `jsonStore`，不再有裸的 settings.json 文件。
   * 读法用 Node 24 自带的 `node:sqlite`（不引依赖）。
   */
  const db = path.join(DATA, "stores.db");
  if (!fs.existsSync(db)) return null;
  const conn = new DatabaseSync(db, { readOnly: true });
  try {
    const row = conn.prepare("SELECT value FROM kv WHERE key = ?").get("settings.json");
    if (!row) return null;
    const raw = JSON.parse(String(row.value));
    return raw && typeof raw === "object" && "data" in raw ? raw.data : raw;
  } finally {
    conn.close();
  }
};

const boot = async () => bootApp({ port: PORT, dataDir: DATA, timeoutMs: 30000 });

try {
  /* ── 第一次启动 ── */
  const first = await boot();
  child = first.child;
  if (!first.ok) {
    console.error("[诊断] 应用输出尾部：\n" + (first.getLog() || "(空)").slice(-1200));
    await killTree(child);
    process.exit(1);
  }
  const b1 = await connectWithRetry(chromium, `http://127.0.0.1:${PORT}`);
  const page = await waitForPage(b1);
  if (!page) throw new Error(NO_PAGE_HINT);
  await page.waitForSelector('[data-testid="wb"]', { timeout: 20000 });
  await page.waitForTimeout(1500);

  await openSettings(page);
  await openGeneral(page);

  out.panel = {
    root: (await page.locator('[data-testid="wb-personalize"]').count()) > 0,
    theme: (await page.locator('[data-testid="wb-personalize-theme"]').count()) > 0,
    keyPalette: (await page.locator('[data-testid="wb-personalize-key-palette"]').count()) > 0,
    call: (await page.locator('[data-testid="wb-personalize-call"]').count()) > 0,
    style: (await page.locator('[data-testid="wb-personalize-style"]').count()) > 0,
    extra: (await page.locator('[data-testid="wb-personalize-extra"]').count()) > 0,
  };

  /* ② 主题：选深色 → 属性与底色都变 */
  await page.selectOption('[data-testid="wb-personalize-theme"]', "dark");
  await page.waitForTimeout(700);
  out.theme = await page.evaluate(() => ({
    attr: document.documentElement.getAttribute("data-theme"),
    stored: localStorage.getItem("dsh-canvas.theme"),
    bg: getComputedStyle(document.querySelector(".wb")).backgroundColor,
  }));

  /* ③ 录制新快捷键：点一下 → 按 Ctrl+J → 按钮显示 Ctrl J */
  await page.locator('[data-testid="wb-personalize-key-palette"]').click();
  await page.waitForTimeout(300);
  await page.keyboard.press("Control+j");
  await page.waitForTimeout(900);
  out.chordText = (await page.locator('[data-testid="wb-personalize-key-palette"]').textContent())?.trim() ?? "";

  /* 裸键要被拒：点一下 → 按 k（不带修饰键）→ 出现错误提示、键位不变 */
  await page.locator('[data-testid="wb-personalize-key-palette"]').click();
  await page.waitForTimeout(300);
  await page.keyboard.press("k");
  await page.waitForTimeout(600);
  out.bareKey = {
    error: (await page.locator('[data-testid="wb-personalize-key-error"]').count()) > 0,
    text: (await page.locator('[data-testid="wb-personalize-key-palette"]').textContent())?.trim() ?? "",
  };
  /* 录制在按下裸键那一刻就结束了（校验失败 → 报错、键位不变）；这里不要再按 Esc ——
     那一下会被设置弹窗接住，把整页关掉（第一次跑就是这么翻车的）。 */

  /* ④ 人格：称呼「主人」+ 语气简洁（blur 触发保存） */
  await page.locator('[data-testid="wb-personalize-call"]').fill("主人");
  await page.locator('[data-testid="wb-personalize-call"]').blur();
  await page.selectOption('[data-testid="wb-personalize-style"]', "concise");
  await page.waitForTimeout(1000);

  out.disk = settingsOnDisk();
  out.diskSummary = {
    keymapPalette: out.disk?.keymap?.palette,
    persona: out.disk?.persona,
  };

  /* 关设置，试新快捷键：Ctrl+J 应该开命令面板，Ctrl+K 不该再开 */
  await page.locator('[data-testid="wb-settings-close"]').click();
  await page.waitForTimeout(600);
  await page.keyboard.press("Control+j");
  await page.waitForTimeout(700);
  out.customChordOpensPalette = (await page.locator('[data-testid="wb-palette"]').count()) > 0;
  await page.keyboard.press("Escape");
  await page.waitForTimeout(400);
  await page.keyboard.press("Control+k");
  await page.waitForTimeout(700);
  out.oldChordStillOpens = (await page.locator('[data-testid="wb-palette"]').count()) > 0;
  await page.keyboard.press("Escape").catch(() => undefined);

  out.shot = await shot(page, "personalize-1.png");
  await b1.close();
  await killTree(child);
  child = null;

  /* ── 第二次启动：跨重启 ── */
  const second = await boot();
  child = second.child;
  if (!second.ok) throw new Error("第二次启动失败：" + (second.getLog() || "").slice(-600));
  const b2 = await connectWithRetry(chromium, `http://127.0.0.1:${PORT}`);
  const page2 = await waitForPage(b2);
  if (!page2) throw new Error(NO_PAGE_HINT);
  await page2.waitForSelector('[data-testid="wb"]', { timeout: 20000 });
  await page2.waitForTimeout(1500);

  out.restart = await page2.evaluate(() => ({
    attr: document.documentElement.getAttribute("data-theme"),
    stored: localStorage.getItem("dsh-canvas.theme"),
  }));

  await openSettings(page2);
  await openGeneral(page2);
  out.afterRestart = {
    chord:
      (await page2.locator('[data-testid="wb-personalize-key-palette"]').textContent())?.trim() ?? "",
    call: await page2.locator('[data-testid="wb-personalize-call"]').inputValue(),
    style: await page2.locator('[data-testid="wb-personalize-style"]').inputValue(),
    theme: await page2.locator('[data-testid="wb-personalize-theme"]').inputValue(),
  };
  out.shot2 = await shot(page2, "personalize-2.png");
  await b2.close();
} catch (e) {
  out.error = String(e).slice(0, 300);
} finally {
  await killTree(child);
  console.log(JSON.stringify(out, null, 2));
  const bad = [];
  if (!out.panel?.root) bad.push("通用页里没有个性化面板");
  for (const key of ["theme", "keyPalette", "call", "style", "extra"]) {
    if (!out.panel?.[key]) bad.push(`面板里缺 ${key}`);
  }
  if (out.theme?.attr !== "dark") bad.push(`选了深色但 data-theme=${JSON.stringify(out.theme?.attr)}`);
  if (out.theme?.stored !== "dark") bad.push("深色没写进 localStorage");
  if (out.chordText !== "Ctrl J") bad.push(`录了 Ctrl+J 但按钮显示 ${JSON.stringify(out.chordText)}`);
  if (!out.bareKey?.error) bad.push("裸键 k 没给出错误提示");
  if (out.bareKey?.text !== "Ctrl J") bad.push(`裸键被拒之后键位被改了：${JSON.stringify(out.bareKey?.text)}`);
  if (out.diskSummary?.keymapPalette !== "Mod+J") bad.push(`settings.json 里的键位是 ${JSON.stringify(out.diskSummary?.keymapPalette)}`);
  if (out.diskSummary?.persona?.callUser !== "主人") bad.push("settings.json 里没有 persona.callUser");
  if (out.diskSummary?.persona?.style !== "concise") bad.push("settings.json 里没有 persona.style=concise");
  if (!out.customChordOpensPalette) bad.push("按 Ctrl+J 没开命令面板（自定义键位没生效）");
  if (out.oldChordStillOpens) bad.push("旧键位 Ctrl+K 还能开面板（两个键位同时活了？）");
  if (out.restart?.attr !== "dark") bad.push(`重启后主题不是深色（${JSON.stringify(out.restart?.attr)}）`);
  if (out.afterRestart?.chord !== "Ctrl J") bad.push(`重启后键位提示是 ${JSON.stringify(out.afterRestart?.chord)}`);
  if (out.afterRestart?.call !== "主人") bad.push(`重启后称呼是 ${JSON.stringify(out.afterRestart?.call)}`);
  if (out.afterRestart?.style !== "concise") bad.push(`重启后语气是 ${JSON.stringify(out.afterRestart?.style)}`);
  if (out.afterRestart?.theme !== "dark") bad.push(`重启后主题下拉是 ${JSON.stringify(out.afterRestart?.theme)}`);
  if (out.error) bad.push("异常: " + out.error);
  if (bad.length) {
    console.error("✗ " + bad.join("；"));
    process.exitCode = 1;
  } else {
    console.log("✓ 个性化三块都真的生效，且跨重启记住");
  }
}
