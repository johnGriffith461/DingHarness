import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";
import { NO_PAGE_HINT, bootApp, freshDir, killTree, shot, waitForPage } from "./harness.mjs";

/**
 * 验收：**钉住的默认模型失效时，界面上要说出来**（§184）。
 *
 * ## 这条**不调模型**（进批跑）
 *
 * 起因：§183 写了"钉的失效就退回上次并标出 `fellBack`"，但当时传给 `pickRoute`
 * 的可用列表**是空数组** → 而"空数组 = 没拿到信息，按还在处理" →
 * **兜底逻辑实际永远不会触发**（逻辑写了、路没通）。
 *
 * 现在由纯函数 `pinnedStatus(pinned, available)` 回答"还能不能用"，
 * 并且**设置那一行会标出来**。这条验收就验这个：
 *
 * ① 种一个**形状对但不存在**的默认（`nope/nope`）→ 通用那行标「（不可用）」
 * ② 种一个**真实可用**的默认 → **不标**
 */
const DATA = "D:/DoubaoWorkClone/.verify/pinneddead-data";
if (!(await freshDir(DATA))) {
  console.error("✗ 数据目录 " + DATA + " 删不掉 —— 先手工关掉占着它的 Electron");
  process.exit(1);
}
fs.mkdirSync(DATA, { recursive: true });

const PORT = 9336;
const out = {};
let child = null;

const boot = async () => bootApp({ port: PORT, dataDir: DATA, timeoutMs: 30000 });

const writePin = (value) => {
  fs.writeFileSync(path.join(DATA, "settings.json"), JSON.stringify({ pinnedModel: value }, null, 2), "utf8");
};

const openSettings = async (page) => {
  await page.locator('[data-testid="wb-account"]').click();
  await page.waitForTimeout(600);
  await page.locator('[data-testid="wb-acct-settings"]').click();
  await page.waitForTimeout(1200);
};

const generalRow = (page) =>
  page.evaluate(() => document.querySelector('[data-testid="wb-set-通用"]')?.textContent?.trim() ?? "");

try {
  /* ── ① 形状对但不存在 ── */
  writePin("nope/nope");
  const first = await boot();
  child = first.child;
  if (!first.ok) {
    console.error("[诊断] 应用输出尾部：\n" + (first.getLog() || "(空)").slice(-1200));
    await killTree(child);
    process.exit(1);
  }
  const b1 = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
  const page = await waitForPage(b1);
  if (!page) throw new Error(NO_PAGE_HINT);
  await page.waitForSelector('[data-testid="wb"]', { timeout: 20000 });
  await openSettings(page);
  out.rowDead = await generalRow(page);

  /* 顺手记下真实可选项，给第二轮用 */
  await page.locator('[data-testid="wb-set-通用"]').click();
  await page.waitForTimeout(1200);
  out.options = await page.evaluate(() =>
    Array.from(document.querySelectorAll('[data-testid="wb-setpage-pinned"] option'))
      .map((e) => e.value)
      .filter(Boolean),
  );
  out.shot = await shot(page, "pinneddead.png");
  await b1.close();
  await killTree(first.child);
  child = null;

  /* ── ② 真实可用的一个 ── */
  const real = (out.options ?? [])[0];
  if (!real) {
    out.error = "环境里没有可选模型（第二轮没法验）";
  } else {
    writePin(real);
    await new Promise((r) => setTimeout(r, 1500));
    const second = await boot();
    child = second.child;
    if (!second.ok) {
      console.error("[诊断] 第二次启动失败：\n" + (second.getLog() || "(空)").slice(-800));
      await killTree(child);
      process.exit(1);
    }
    const b2 = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
    const page2 = await waitForPage(b2);
    if (!page2) throw new Error(NO_PAGE_HINT);
    await page2.waitForSelector('[data-testid="wb"]', { timeout: 20000 });
    await openSettings(page2);
    out.rowAlive = await generalRow(page2);
    out.realPin = real;
    await b2.close();
  }
} catch (e) {
  out.error = String(e).slice(0, 300);
} finally {
  console.log(JSON.stringify(out, null, 2));
  await killTree(child);

  const bad = [];
  if (out.error) bad.push("异常: " + out.error);

  /* ① 失效的要标出来 */
  if (!(out.rowDead ?? "").includes("不可用")) {
    bad.push(`⭐ 钉的模型不存在时那行没标出来：${out.rowDead}`);
  }
  if (!(out.rowDead ?? "").includes("nope/nope")) {
    bad.push(`那行没显示钉的值：${out.rowDead}`);
  }

  /* ② 可用的不许误报 */
  if ((out.rowAlive ?? "").includes("不可用")) {
    bad.push(`⭐ 钉的模型可用时误报了「不可用」：${out.rowAlive}`);
  }
  if (!(out.rowAlive ?? "").includes(out.realPin ?? "___")) {
    bad.push(`那行没显示钉的值：${out.rowAlive}`);
  }

  if (bad.length) {
    console.error("✗ " + bad.join("；"));
    process.exitCode = 1;
  } else {
    console.log("✓ 失效提示成立：钉了个不存在的 → 那行标「不可用」；钉了个真可用的 → 不误报");
  }
}
