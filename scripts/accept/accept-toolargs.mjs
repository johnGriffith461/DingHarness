import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";
import { NO_PAGE_HINT, bootApp, freshDir, killTree, shot, waitForPage } from "./harness.mjs";

/**
 * 验收：**工具参数真的出现在留痕里**（§175）。
 *
 * ## 为什么必须真调模型
 *
 * `toolArgsSummary` 有 12 条单测，但"**参数真的从模型那里流到界面上**"
 * 只能真跑一次 —— 中间隔着 IPC 事件、两条消费路径（聊天 / 工作台）。
 *
 * ## 断言
 *
 * ① 这一轮真的调了工具（有留痕）
 * ② ⭐ 那一行里出现了**只有参数里才有**的东西（`阿岩`）——
 *    没有参数的话，那一行只可能写"已保存，当前 N 条"
 * ③ 记忆库里真的存下了这条（顺带确认凭据链路没坏）
 *
 * ⚠️ 会真调模型（1 次）。工具策略若要求确认，那一行会是"等你确认"——
 * **那条同样该带参数**（用户正要决定放不放行），所以两种都算通过。
 */
const DATA = "D:/DoubaoWorkClone/.verify/toolargs-data";
if (!(await freshDir(DATA))) {
  console.error("✗ 数据目录 " + DATA + " 删不掉 —— 先手工关掉占着它的 Electron");
  process.exit(1);
}
fs.mkdirSync(DATA, { recursive: true });

const PORT = 9327;
const { child, ok, getLog } = await bootApp({ port: PORT, dataDir: DATA, timeoutMs: 30000 });
if (!ok) {
  console.error("[诊断] 应用输出尾部：\n" + (getLog() || "(空)").slice(-1200));
  await killTree(child);
  process.exit(1);
}

const out = {};
try {
  const b = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
  const page = await waitForPage(b);
  if (!page) throw new Error(NO_PAGE_HINT);
  await page.waitForSelector('[data-testid="wb"]', { timeout: 20000 });

  await page.locator('[data-testid="wb-nav-home"]').click();
  await page.waitForTimeout(700);
  await page
    .locator('[data-testid="wb-composer-input"]')
    .fill("请记住这件事：我叫阿岩。记住之后就一句话确认，不用展开。");
  await page.locator('[data-testid="wb-send"]').click();

  /* 等留痕出现 */
  const deadline = Date.now() + 120000;
  while (Date.now() < deadline) {
    await page.waitForTimeout(2500);
    const n = await page.locator(".wb-tool-line").count();
    if (n > 0) break;
  }
  out.lines = await page.evaluate(() =>
    Array.from(document.querySelectorAll(".wb-tool-line")).map((e) => (e.textContent ?? "").trim()),
  );

  /* 记忆库真的存下来了吗 */
  await page.waitForTimeout(1500);
  const mem = path.join(DATA, "memory.json");
  out.memory = fs.existsSync(mem) ? JSON.parse(fs.readFileSync(mem, "utf8")) : null;
  out.shot = await shot(page, "toolargs.png");

  await b.close();
} catch (e) {
  out.error = String(e).slice(0, 300);
} finally {
  console.log(JSON.stringify(out, null, 2));
  await killTree(child);

  const bad = [];
  if (out.error) bad.push("异常: " + out.error);

  const lines = out.lines ?? [];
  if (lines.length === 0) bad.push("这一轮没有任何工具留痕（模型没调工具？）");

  /* ② 参数里的东西出现在留痕里 */
  const withArgs = lines.filter((l) => l.includes("阿岩"));
  if (withArgs.length === 0) {
    bad.push(`⭐ 留痕里没有参数里的内容（只写了结果）：${JSON.stringify(lines)}`);
  }

  /* ③ 记忆真的存了（或者那一行是"等你确认"） */
  const entries = out.memory?.entries ?? [];
  const pending = lines.some((l) => l.includes("等你确认"));
  if (entries.length === 0 && !pending) {
    bad.push(`记忆库是空的，留痕也不是"等你确认"：${JSON.stringify(out.memory)}`);
  }

  if (bad.length) {
    console.error("✗ " + bad.join("；"));
    process.exitCode = 1;
  } else {
    console.log(`✓ 工具参数进留痕成立：那一行是「${withArgs[0]}」—— 只有参数里才有「阿岩」`);
  }
}
