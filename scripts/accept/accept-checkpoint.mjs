import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";
import { bootApp, connectWithRetry, finishedTurns, freshDir, readStoreFile, killTree, shot, waitTurnEnd } from "./harness.mjs";

/**
 * 验收：**会话检查点**（§151）—— 回退与分叉。
 *
 * ## 五条断言，各自堵一种"看着像做了"
 *
 * ① **分叉**真的产出一段新对话（左栏多一行 + 新对话标题带「分支」+ 它只有 2 个气泡）
 * ② **分叉不改原对话**（回到原来那段，气泡还是 4 个）
 * ③ **回退**丢掉之后的轮次（助手气泡从 2 → 1，再重答回 2），且**用户那两句都还在**
 * ④ ⭐ **回退不撤销已发生的动作**：第一轮写进 `memory.json` 的 42 **还在**
 * ⑤ 按钮确实存在（不然上面几条无从谈起）
 *
 * ④ 是这一条最要紧的断言 —— 它是这个功能的**边界**，
 * 也是用户最容易误解的地方（以为"回退"= 时光倒流）。
 *
 * ⚠️ **这条会真调模型**（约 2~3 分钟），不进无模型批跑。
 */
const DATA = ".verify/checkpoint-data";
if (!(await freshDir(DATA))) {
  console.error("✗ 数据目录 " + DATA + " 删不掉 —— 先手工关掉占着它的 Electron");
  process.exit(1);
}

/* ⚠️ 2026-10-16（审计 G06/G07）：bootApp 会换端口重试 —— 下面用的是它返回的实际端口，不再假设给哪个就用哪个 */
let PORT = 9300;
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

  const users = () => page.locator(".wb-bubble-user").count();
  const assistants = () => page.locator(".wb-assistant-text").count();
  const recentIds = () =>
    page.evaluate(() =>
      Array.from(document.querySelectorAll('[data-testid^="wb-recent-"]')).map((e) =>
        (e.getAttribute("data-testid") ?? "").replace("wb-recent-", ""),
      ),
    );
  const title = () => page.evaluate(() => document.querySelector('[data-testid="wb-task-title"]')?.textContent?.trim() ?? "");
  /*
   * ⚠️ 2026-10-16（审计 G107）：原来这里回**整份 memory.json 的文本**，
   * 而下面拿 `includes("42")` 当判据 —— 条目里的 ISO 时间戳（如 `2026-10-16T04:42:…`）
   * 就能满足它，于是"记忆里真的存了 42"这条断言**恒真**。
   * 现在只认**条目正文**里的 "42"（走 readStoreFile 拆信封）。
   */
  const memoryTexts = () => {
    const f = path.join(DATA, "memory.json");
    if (!fs.existsSync(f)) return [];
    try {
      const lib = readStoreFile(f);
      const entries = Array.isArray(lib?.entries) ? lib.entries : [];
      return entries.map((e) => String(e?.text ?? ""));
    } catch {
      return [];
    }
  };
  const memoryHas42 = () => memoryTexts().some((t) => t.includes("42"));
  const send = async (text, _wantAssistants) => {
    /*
     * ⚠️ 2026-10-16（审计 G108）：原来等的是「助手气泡 count 到预期值」，那是**半截回复**
     * （首 token 一出现就退出循环）。这条脚本最要紧的三条断言（分叉真的产出新对话、
     * 分叉不改原对话、回退不撤销已发生的动作）都在读**这一轮的正文与轮次数** ——
     * 慢回答下会读到没写完的话，还会在上一条没结束时就发下一条（轮次数不再确定）。
     * 现在等会话记录里的 `done`：引擎自己定义的终态（见 harness 的 `waitTurnEnd`）。
     */
    const before = await finishedTurns(page);
    await page.locator('[data-testid="wb-composer-input"]').fill(text);
    await page.locator('[data-testid="wb-send"]').click();
    await waitTurnEnd(page, before, 120_000);
    for (let i = 0; i < 3; i += 1) {
      if ((await page.locator('[data-testid="wb-question-card"]').count()) === 0) break;
      await page.locator('[data-testid="wb-option-0"]').first().click();
      await page.waitForTimeout(2500);
    }
  };

  /* ── 两轮对话（第一轮真的写一次记忆，好验"副作用不撤销"）── */
  await page.locator('[data-testid="wb-nav-home"]').click();
  await page.waitForTimeout(800);
  await send("请调用 memory_save 工具记住：我的幸运数字是 42。然后只回复「好」。", 1);
  await send("我最喜欢的颜色是蓝色。只回复「好」。", 2);

  out.userBefore = await users();
  out.assistantBefore = await assistants();
  out.memoryBefore = memoryHas42();
  const rowsBefore = await recentIds();
  out.originalId = rowsBefore[0] ?? null;

  /* ── ② 分叉（在最后一条助手消息上）── */
  const branchBtns = page.locator('[data-testid^="wb-act-branch-"]');
  out.branchBtnCount = await branchBtns.count();
  const rowsBeforeFork = rowsBefore.length;
  await branchBtns.last().click();
  /*
   * ⚠️ 2026-10-16（审计 G108 同一条毛病）：这里原来是固定 `waitForTimeout(1500)` 就读标题与条数 ——
   * 分叉慢一点读到的是**还没落地的状态**。改成等**可判定的结果**：左栏真的多出一行
   * （这正是下面 `recentGrew` 要断的那件事），等不到就如实红。
   */
  {
    const forkDeadline = Date.now() + 30_000;
    while (Date.now() < forkDeadline && (await recentIds()).length <= rowsBeforeFork) {
      await page.waitForTimeout(300);
    }
  }
  out.branchTitle = await title();
  out.branchUsers = await users();
  out.branchAssistants = await assistants();
  const rowsAfter = await recentIds();
  out.recentGrew = rowsAfter.length === rowsBefore.length + 1;
  out.branchShot = await shot(page, "checkpoint-branch.png");

  /* ── 回到原对话（分叉不该动它）── */
  await page.locator(`[data-testid="wb-recent-${out.originalId}"]`).click();
  await page.waitForTimeout(1200);
  out.originalUsers = await users();
  out.originalAssistants = await assistants();

  /* ── ③ 回退（在最后一条助手消息上 = "这条回答重来"）── */
  const rewindBtns = page.locator('[data-testid^="wb-act-rewind-"]');
  out.rewindBtnCount = await rewindBtns.count();
  await rewindBtns.last().click();

  /*
   * ⚠️ 观察点必须是**确定性**的。
   *
   * 第一版盯的是"助手气泡先掉到 1 再回到 2"—— 那是**时序观察**：
   * 1.5 秒轮询会漏过那个窗口（这次就漏了）。改了产品侧：
   * 重答那一步带一句「已回到这一步重新回答」，于是"回退真的发生了"变成**可读的**。
   */
  const deadline = Date.now() + 120000;
  let note = "";
  while (Date.now() < deadline) {
    await page.waitForTimeout(1500);
    note = await page.evaluate(() => {
      const el = document.querySelector('[data-testid^="wb-note-"]');
      return el ? (el.textContent ?? "").trim() : "";
    });
    if (note.includes("重新回答")) break;
  }
  out.rewindNote = note;
  out.userAfter = await users();
  out.assistantAfter = await assistants();
  out.memoryAfter = memoryHas42();
  out.shot = await shot(page, "checkpoint-rewind.png");

  await b.close();
} catch (e) {
  out.error = String(e).slice(0, 300);
} finally {
  console.log(JSON.stringify(out, null, 2));
  await killTree(child);

  const bad = [];
  if (out.error) bad.push("异常: " + out.error);

  /* ① 按钮在 */
  if (!(out.branchBtnCount > 0)) bad.push("没有「分叉」按钮");
  if (!(out.rewindBtnCount > 0)) bad.push("没有「回退」按钮");
  /* ① 分叉真的产出新对话 */
  if (!out.recentGrew) bad.push("分叉之后左栏没有多出一段对话");
  if (!(out.branchTitle ?? "").includes("分支")) bad.push(`新对话标题没标分支：${out.branchTitle}`);
  if (out.branchUsers !== 2 || out.branchAssistants !== 2) {
    bad.push(`分叉出来的对话内容不对（用户 ${out.branchUsers} / 助手 ${out.branchAssistants}）`);
  }
  /* ② 分叉不改原对话 */
  if (out.originalUsers !== out.userBefore || out.originalAssistants !== out.assistantBefore) {
    bad.push(`分叉动了原对话（用户 ${out.originalUsers} / 助手 ${out.originalAssistants}）`);
  }
  /* ③ 回退丢掉之后那轮，再重答（用"重答那一步的说明"作确定性证据） */
  if (!(out.rewindNote ?? "").includes("重新回答")) {
    bad.push(`回退没有发生（没看到「已回到这一步重新回答」）：${JSON.stringify(out.rewindNote)}`);
  }
  if (out.userAfter !== 2) bad.push(`回退把用户那两句弄丢了（只剩 ${out.userAfter}）`);
  if (out.assistantAfter !== 2) bad.push(`回退之后没有重答回来（助手 ${out.assistantAfter}）`);
  /* ④ ⭐ 边界：回退不撤销已发生的动作 */
  if (!out.memoryBefore) bad.push("第一轮压根没写进记忆 —— 这条断言就失去意义了，先看前面");
  if (!out.memoryAfter) bad.push("⚠️ 回退把记忆里的 42 弄没了 —— 回退不该撤销已发生的动作（它改的是对话，不是世界）");

  if (bad.length) {
    console.error("✗ " + bad.join("；"));
    process.exitCode = 1;
  } else {
    console.log("✓ 会话检查点成立：分叉产出新对话且不动原对话；回退丢掉之后那轮并重答，且**不撤销已发生的动作**");
  }
}
