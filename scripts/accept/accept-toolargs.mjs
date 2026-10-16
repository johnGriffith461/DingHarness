import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";
import { NO_PAGE_HINT, bootApp, connectWithRetry, freshDir, killTree, readStoreFile, shot, waitForPage } from "./harness.mjs";

/**
 * 验收：**工具参数真的出现在留痕里**（§175）。
 *
 * ## 为什么必须真调模型
 *
 * `toolArgsSummary` 有 12 条单测，但"**参数真的从模型那里流到界面上**"
 * 只能真跑一次 —— 中间隔着 IPC 事件、两条消费路径（聊天 / 工作台）。
 *
 * ⚠️ **这条原来会真调模型**（1 次），不进无模型批跑。
 * 2026-10-16 收进批跑：假通道认得「请调用 <工具名> 工具」这条**既有**装置标记
 * （见 `verify-acceptances.mjs` 的 `startLocalFakeModel`）—— 它会回一个真的
 * `memory_save` 调用，**参数就是用户那句话**。于是"那一行里出现只有参数里才有的东西"
 * 依旧等价于"参数真的从模型那边流到了界面上"，判据一字未改。
 *
 * ## 断言
 *
 * ① 这一轮真的调了工具（有留痕）
 * ② ⭐ 那一行里出现了**只有参数里才有**的东西（`阿岩`）——
 *    没有参数的话，那一行只可能写"已保存，当前 N 条"
 * ③ 记忆库里真的存下了这条（顺带确认凭据链路没坏）
 *
 * ⚠️ 档位设成**全部允许**：这样那一轮是"真的执行了"而不是"等你确认"——
 * 两条路都算通过（见下面 ③ 的判据），但执行那条能顺带把 ③ 压得更实。
 */
const DATA = ".verify/toolargs-data";
if (!(await freshDir(DATA))) {
  console.error("✗ 数据目录 " + DATA + " 删不掉 —— 先手工关掉占着它的 Electron");
  process.exit(1);
}
fs.mkdirSync(DATA, { recursive: true });

/* ⚠️ 2026-10-16（审计 G06/G07）：bootApp 会换端口重试 —— 下面用的是它返回的实际端口，不再假设给哪个就用哪个 */
let PORT = 9327;
const booted = await bootApp({ port: PORT, dataDir: DATA, timeoutMs: 30000 });
const { child, ok, getLog } = booted;
/* 用实际端口（bootApp 换过端口时它与首选不同） */
PORT = booted.port;
if (!ok) {
  console.error("[诊断] 应用输出尾部：\n" + (getLog() || "(空)").slice(-1200));
  await killTree(child);
  process.exit(1);
}

const out = {};
try {
  const b = await connectWithRetry(chromium, `http://127.0.0.1:${PORT}`);
  const page = await waitForPage(b);
  if (!page) throw new Error(NO_PAGE_HINT);
  await page.waitForSelector('[data-testid="wb"]', { timeout: 20000 });

  /* ⚠️ 闸门设成全部允许（见文件头那段）：让这一轮真的执行，而不是停在「等你确认」 */
  await page.evaluate(() => localStorage.setItem("dsh-canvas.confirm-mode", "全部允许"));
  await page.reload();
  await page.waitForSelector('[data-testid="wb"]', { timeout: 20000 });

  await page.locator('[data-testid="wb-nav-home"]').click();
  await page.waitForTimeout(700);
  /*
   * ⚠️ 提示词带上**装置标记**「请调用 memory_save 工具」（原来没有它 ——
   * 它赌"真模型会自己决定调工具"，而那是**模型行为**，本来就不该是这条验收的前提）。
   * 参数里的 `阿岩` 就在这句话里，判据（留痕里出现它）一字未改。
   */
  await page
    .locator('[data-testid="wb-composer-input"]')
    .fill("请调用 memory_save 工具记住这件事：我叫阿岩（复述:阿岩）。记住之后就一句话确认，不用展开。");
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
  out.memory = fs.existsSync(mem) ? readStoreFile(mem) : null;
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
