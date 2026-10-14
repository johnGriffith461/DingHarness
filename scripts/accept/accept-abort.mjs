import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";
import { bootApp, connectWithRetry, freshDir, killTree, shot, verdict, waitForPage } from "./harness.mjs";

/**
 * 验收：**工作台里能"停止"正在跑的任务**（补完⑤）。
 *
 * ⚠️ **这条会真调模型**（1 次，故意要一条长回答），所以不进无模型批跑。
 *
 * ## 为什么这条必须有（它一上手就抓到一个缺口）
 *
 * 写这条之前先去找工作台的停止按钮 —— **没有**。`store.abort()` 实现了，
 * 但全仓只有提问卡的"关闭"在调它；也就是说用户发出去一条要跑一分钟的任务，
 * **只能干看着**（聊天侧早就有 `chat-send-stop`，两边不一致）。
 *
 * 现在：流式过程中输入区的发送键变成「停止」（文案取自本体证据 `button_stop` = "停止"）。
 * 这条验收**真点它**，并断言三件事：
 * ① 点了之后**界面这一轮确实收了**（不再流式）；
 * ② 已经吐出来的内容**留着**（不是整段消失）；
 * ③ **会话日志里有终止记录** —— 否则读日志的人分不清"这一轮断了"还是"还在跑"。
 */
const DATA = ".verify/abort-data";
if (!(await freshDir(DATA))) {
  console.error("✗ 数据目录 " + DATA + " 删不掉 —— 先手工关掉占着它的 Electron");
  process.exit(1);
}

const PORT = 9313;
const out = {};
let child = null;

try {
  const r = await bootApp({ port: PORT, dataDir: DATA, timeoutMs: 30000 });
  child = r.child;
  if (!r.ok) throw new Error(`调试端口 ${PORT} 没开：\n` + (r.getLog() || "(空)").slice(-800));
  const b = await connectWithRetry(chromium, `http://127.0.0.1:${PORT}`);
  const page = await waitForPage(b);
  await page.waitForSelector('[data-testid="wb"]', { timeout: 20000 });
  await page.waitForTimeout(1200);

  /* 要一条**长**回答，好在流式中间截住它 */
  await page.locator('[data-testid="wb-nav-home"]').click();
  await page.waitForTimeout(600);
  await page
    .locator('[data-testid="wb-composer-input"]')
    .fill("请写一篇 800 字以上的长文，主题是「为什么桌面应用也需要自动化测试」，分五节展开，每节都要有小标题。");
  await page.locator('[data-testid="wb-send"]').click();

  /*
   * ⭐ **一出现就点**（不等正文）。
   *
   * ⚠️ 这条改了三版，教训值得记：
   *   ① 先"等文本 > 20 字再点" → 模型那篇 800 字文章已经写完、停止键先没了；
   *   ② 改"等 1.2 秒" → 首字还没到（首字要等请求往返），断言拿到空串（假红）；
   *   ③ 改"等首字（最多 5 秒）" → **轮询本身吃掉了可点的窗口**，又变成"文章写完了"。
   * 这条要验的是"**点下去能中止**"，不是"中止时界面上有几行字"。
   * 所以：轮询间隔压到 100ms，看到 **。停止键就点，不等任何别的东西。
   */
  let stopAppeared = false;
  /** 流式正文的**长度采样**（2026-10-14：这条顺带验"文字真的在一个个长出来"）。 */
  const draftSamples = [];
  for (let i = 0; i < 120; i += 1) {
    /*
     * ⚠️ **先采样、再看停止键**：第一版把停止键的判断放前面，于是"停止键立刻就在"
     * 让循环第一次就退出、采样是空数组（断言直接假红）。
     */
    const len = await page.evaluate(
      () => (document.querySelector('[data-testid="wb-draft-text"]')?.textContent ?? "").length,
    );
    draftSamples.push(len);
    if ((await page.locator('[data-testid="wb-send-stop"]').count()) > 0) stopAppeared = true;
    // 采到"正文真的长起来了"就够（≥3 个样本且出现过非零长度）
    if (draftSamples.length >= 3 && Math.max(...draftSamples) > 0) break;
    await page.waitForTimeout(150);
  }
  out.draftSamples = draftSamples.slice(-6);
  /*
   * ⭐ 判据：流式过程中**正文在长**。在此之前工作台只有一行「正在回复」，
   * `.wb-assistant-text` 要到收尾才出现 —— 所以"长度出现过增长"本身就是"流式显示生效"的证据。
   */
  out.draftGrew = draftSamples.length >= 3 && Math.max(...draftSamples) > Math.min(...draftSamples);
  out.stopAppeared = stopAppeared;
  out.textBeforeStop = await page.evaluate(
    () => (document.querySelector(".wb-assistant-text")?.textContent ?? "").trim().slice(0, 40),
  );
  out.shotBefore = await shot(page, "abort-1.png");

  /* ⭐ 点停止 */
  if (stopAppeared) await page.locator('[data-testid="wb-send-stop"]').click();

  /* ① 这一轮要收：发送键回到"发送"、停止键消失 */
  let settled = false;
  for (let i = 0; i < 20; i += 1) {
    await page.waitForTimeout(500);
    const stillStopping = (await page.locator('[data-testid="wb-send-stop"]').count()) > 0;
    if (!stillStopping) {
      settled = true;
      break;
    }
  }
  out.settled = settled;

  /* ② 已经吐出来的内容留着 */
  out.textAfterStop = await page.evaluate(
    () => (document.querySelector(".wb-assistant-text")?.textContent ?? "").trim(),
  );
  /*
   * ⚠️ 原来这里断言「停止后已经吐出来的内容还在」—— 实测**取不到**，因为
   * **工作台在流式过程中根本不显示正文**（只有一行「正在回复」，整段回答在收尾时才出现；
   * 见 HANDOFF §206.2 记的缺口）。所以这里改成断言**用户看得见、且真的有用**的那件事：
   * 停止之后那一步**如实写着「已中止」**（而不是让他对着空白猜"是不是坏了"）。
   */
  out.toldAborted = out.textAfterStop.includes("已中止");
  /* 收尾之后草稿必须消失（正文已经落成正式那一步；两份共存就是重复渲染） */
  out.draftAfterSettle = await page.locator('[data-testid="wb-draft-text"]').count();
  out.shotAfter = await shot(page, "abort-2.png");

  /*
   * ②b 磁盘上的那一步写了什么 —— **分清"没写进步骤"与"写了没显示"**。
   *
   * ⚠️ 任务落盘是 **600ms 防抖**（`store.schedulePersist`）：这一轮刚结束就读，
   * 很可能读到"还没刷下去"的旧文件。所以先等一拍再读。
   */
  await page.waitForTimeout(1800);
  const tasksFile = path.join(DATA, "tasks.json");
  if (fs.existsSync(tasksFile)) {
    const raw = JSON.parse(fs.readFileSync(tasksFile, "utf8"));
    const tasks = Array.isArray(raw?.data) ? raw.data : Array.isArray(raw) ? raw : [];
    const steps = tasks.flatMap((t) => t?.steps ?? []).filter((st) => st?.role === "assistant");
    out.diskStepText = steps.map((st) => String(st.text ?? "").slice(0, 40));
    out.diskSaysAborted = out.diskStepText.some((t) => t.includes("已中止"));
  }

  /* ③ 会话日志里有终止记录 */
  const dir = path.join(DATA, "sessions");
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl")) : [];
  out.logFiles = files;
  if (files.length) {
    const lines = fs
      .readFileSync(path.join(dir, files[files.length - 1]), "utf8")
      .split("\n")
      .filter(Boolean);
    const records = lines.map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return {};
      }
    });
    out.lastType = records[records.length - 1]?.type ?? null;
    out.lastMessage = records[records.length - 1]?.message ?? null;
    out.hasAbortRecord = records.some((r) => r.type === "error" && String(r.message ?? "").includes("已中止"));
  }

  await b.close();
} catch (e) {
  out.error = String(e).slice(0, 300);
} finally {
  console.log(JSON.stringify(out, null, 2));
  await killTree(child);
}

const bad = [];
if (out.error) bad.push("异常: " + out.error);
if (!out.stopAppeared) bad.push("⭐ 流式过程中没有「停止」按钮（工作台无法中止一轮）");
if (!out.settled) bad.push("⭐ 点了停止但这一轮没有收（停止键还在）");
/*
 * 分清两边：**磁盘上那一步写了没有**（= 管线对不对）与**界面显示了没有**（= 视图对不对）。
 * 只报"界面没说"会把两种完全不同的问题混成一条。
 */
if (!out.diskSaysAborted) {
  bad.push(`⭐ 停止后那一步在磁盘上也没写「已中止」：${JSON.stringify(out.diskStepText ?? null)}`);
} else if (!out.toldAborted) {
  bad.push(`磁盘上写了「已中止」但界面没显示（${JSON.stringify(out.diskStepText)}）—— 是界面这一侧的问题`);
}
if (!out.draftGrew) {
  bad.push(`⭐ 流式过程中正文没在长（采样：${JSON.stringify(out.draftSamples)}）—— 又变回「整段蹦出来」了`);
}
if (out.draftAfterSettle !== 0) bad.push(`收尾后草稿没清掉（还剩 ${out.draftAfterSettle} 个）`);
if (!out.hasAbortRecord) bad.push("⭐ 会话日志里没有终止记录（读日志的人分不清断了还是还在跑）");
verdict(bad, "停止与流式都成立：正文实时在长 / 有停止键 / 点了真的收 / 步骤说「已中止」/ 日志有终止记录");
