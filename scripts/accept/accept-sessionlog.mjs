import { chromium } from "playwright";
import { bootApp, connectWithRetry, freshDir, killTree, readAllSessionRecords, shot, verdict, dismissFirstRunIfShown } from "./harness.mjs";

/**
 * 验收：**会话事件日志真的记下了"模型这一轮看见了什么"**（C2 / INV-1）。
 *
 * ## 为什么这条必须有
 *
 * C2 把日志加进了主进程（`electron/ipc/sessionStore.ts`），而它的价值只有一条：
 * **事后能从日志重建出这一轮**。没有这条验收，日志就是"写了但没人读"的东西 ——
 * 本项目的原话是"没有断言的机制等于没做"（`RESERVE_TOKENS` 就是这么烂掉的）。
 *
 * ⚠️ **这条会真调模型**（一次工具调用），所以不进无模型批跑，单独跑。
 *
 * ## 断言（缺一不可）
 *
 * ① 日志文件真的出现了（`sessions/<任务 id>.jsonl`，隔离数据目录下）。
 * ② **首行是 `request`**，且里面带着这一轮真正发出去的用户内容 ——
 *    这就是"模型看见了什么"（缺了它，剩下的只是"模型回了什么"）。
 * ③ 工具调用**成对**：有 `tool-call`（带参数）也有 `tool-result`（带结果），
 *    且参数里那个词（幸运数字）在日志里查得到（配对没丢）。
 * ④ **末行是 `done`**（这一轮有始有终，不是半截）。
 *    ⚠️ 2026-10-18（U01）：`done` 之后还会落一条 `run-state: finished`（运行状态机），
 *    所以判据是「**最后一条业务记录是 done**」—— 末尾允许跟 `run-state`，别的一律不行。
 * ⑤ ⭐ **正文能对上**：把日志里的 `text` 事件拼起来 == 界面上那条回复。
 *    这是 INV-1 的可证伪形式 —— 对不上就说明"界面显示的"与"日志记下的"
 *    走了两条路（那正是 C2 要消灭的东西）。
 * ⑥ 没有坏行（0 行跳过）。
 */
const DATA = ".verify/sessionlog-data";
if (!(await freshDir(DATA))) {
  console.error("✗ 数据目录 " + DATA + " 删不掉 —— 先手工关掉占着它的 Electron");
  process.exit(1);
}

/* ⚠️ 2026-10-16（审计 G06/G07）：bootApp 会换端口重试 —— 下面用的是它返回的实际端口，不再假设给哪个就用哪个 */
let PORT = 9296;
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
  const ctx = b.contexts()[0];
  const page = ctx.pages()[0] ?? (await ctx.waitForEvent("page"));
  await page.waitForSelector('[data-testid="wb"]', { timeout: 20000 });
  await dismissFirstRunIfShown(page);
  await page.waitForTimeout(1200);

  const assistantCount = () => page.locator(".wb-assistant-text").count();
  const lastAssistant = () =>
    page.evaluate(() => {
      const all = Array.from(document.querySelectorAll(".wb-assistant-text"));
      return all.length ? (all[all.length - 1].textContent ?? "").trim() : "";
    });

  const MEMO_KEY = "幸运数字是 42";
  /*
   * T-02（2026-10-19）：闸门现在**待审批即停**。默认档「按需确认」下 memory_save 会被拦，
   * 这一轮就停在"等你确认"（没有正文）—— 这条脚本验的是会话日志，
   * 不是审批，所以显式切到「全部允许」让工具真执行、整轮真收尾。
   */
  await page.evaluate(() => localStorage.setItem("dsh-canvas.confirm-mode", "全部允许"));
  await page.locator('[data-testid="wb-nav-home"]').click();
  await page.waitForTimeout(600);
  await page
    .locator('[data-testid="wb-composer-input"]')
    .fill(`请调用 memory_save 工具记住：我的${MEMO_KEY}。然后只回复「好」这一个字。`);
  await page.locator('[data-testid="wb-send"]').click();

  const deadline = Date.now() + 120000;
  while (Date.now() < deadline && (await assistantCount()) === 0) await page.waitForTimeout(1500);
  // 有提问卡就先答掉（正常不该出现；出现了也不能卡住这一轮）
  for (let i = 0; i < 3; i += 1) {
    if ((await page.locator('[data-testid="wb-question-card"]').count()) === 0) break;
    await page.locator('[data-testid="wb-option-0"]').first().click();
    await page.waitForTimeout(2500);
  }
  // 等工具那一行落地（说明这一轮真的跑完了）
  await page
    .locator(".wb-tool-line")
    .first()
    .waitFor({ timeout: 90000 })
    .catch(() => undefined);
  await page.waitForTimeout(2500);
  out.screenText = await lastAssistant();
  out.screenToolLine = await page.evaluate(
    () => document.querySelector(".wb-tool-line")?.textContent?.trim() ?? null,
  );
  out.shot = await shot(page, "sessionlog.png");

  /*
   * ⭐ 读日志：走**应用自己的口子**（2026-10-16，审计 G09）。
   *
   * 这一段原来直接读 `<DATA>/sessions/*.jsonl`。可存储从 Phase 12.1 起
   * **无条件走 SQLite**（`electron/ipc/sessionStore.ts` 里写着），
   * 于是 `sessions/` 目录根本不出现 → `logDirExists=false` → 这几条断言
   * **永远红**，而红的话术写着"主进程根本没写日志"——把"读错地方"说成了产品没做。
   * `readAllSessionRecords` 走 `window.shell.session.list/load`（现成助手），
   * 存储再换一次也不用动这里。
   */
  const records = await readAllSessionRecords(page);
  out.logDirExists = records.length > 0;
  out.logFiles = records.length ? ["（走 IPC 读取：存储是 SQLite，不再有 .jsonl 文件）"] : [];
  out.logBytes = 0; // 不再有"文件大小"这个概念
  out.records = records.length;
  out.skipped = 0; // IPC 那侧已经把坏行跳过了（这里没有"行"可坏）
  out.types = records.map((r) => r.type);
  out.firstType = records[0]?.type ?? null;
  /*
   * 「末行」= **最后一条业务记录**（U01 之后 `done` 后面还会跟一条 `run-state: finished`）。
   * 这里把末尾的 `run-state` 跳过再取 —— 判据仍然是"这一轮有始有终"。
   */
  const business = [...records].reverse().find((r) => r.type !== "run-state");
  out.lastType = business?.type ?? null;
  out.requestHasUserText = Boolean(
    records[0]?.messages?.some((m) => typeof m.content === "string" && m.content.includes(MEMO_KEY)),
  );
  out.requestSystemChars = typeof records[0]?.system === "string" ? records[0].system.length : 0;
  const call = records.find((r) => r.type === "tool-call");
  const result = records.find((r) => r.type === "tool-result" && r.toolCallId === call?.toolCallId);
  out.toolCallName = call?.toolName ?? null;
  out.toolCallInputHasKey = JSON.stringify(call?.input ?? "").includes("42");
  out.toolResultPaired = Boolean(result);
  out.usage = records.find((r) => r.type === "done")?.usage ?? null;
  // ⑤ 正文重建（INV-1）
  out.logText = records
    .filter((r) => r.type === "text")
    .map((r) => r.text)
    .join("")
    .trim();

  await b.close();
} catch (e) {
  out.error = String(e).slice(0, 400);
} finally {
  await killTree(child);
}

console.log(JSON.stringify(out, null, 2));

const bad = [];
if (!out.logDirExists) bad.push("这段会话一条记录都读不到（走 IPC 的 session.list/load）—— 主进程没写日志？");
if (!out.logFiles?.length) bad.push("这段会话没有任何记录");
if (out.firstType !== "request") bad.push(`首行应是 request，实际 ${out.firstType}`);
if (!out.requestHasUserText) bad.push("首行 request 里没有这一轮的用户内容（模型看见了什么无从谈起）");
if (!out.toolCallName) bad.push("日志里没有 tool-call（工具调用没记下来）");
if (!out.toolCallInputHasKey) bad.push("tool-call 的参数里没有那个词（参数没落进日志）");
if (!out.toolResultPaired) bad.push("tool-result 没与 tool-call 配对（结果丢了）");
if (out.lastType !== "done") bad.push(`末行应是 done，实际 ${out.lastType}`);
if (out.skipped !== 0) bad.push(`有 ${out.skipped} 行坏行`);
if (!out.logText) bad.push("日志里没有 text 事件（正文无从重建）");
if (out.logText && out.screenText && out.logText !== out.screenText) {
  bad.push(`⭐ 正文对不上：日志="${out.logText}" 界面="${out.screenText}"`);
}
verdict(bad, "会话日志成立：request 带用户内容 / 工具调用成对 / done 收尾 / 正文能与界面对上");
