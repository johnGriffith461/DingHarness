import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";
import { NO_PAGE_HINT, bootApp, connectWithRetry, finishedTurns, freshDir, killTree, shot, waitForPage, waitTurnEnd } from "./harness.mjs";

/**
 * 验收：**工具输出真的进了对话历史**（§163）。
 *
 * ## 为什么单独一条（并且原来必须真调模型）
 *
 * `withToolLines` / `outputText` 的行为有单测，但"**模型因此答得出来**"只能真问一次。
 * 而且这件事**跨轮才看得出**：同一轮里 AI SDK 自己会把工具结果喂回去，
 * 所以只有"上一轮调的工具、下一轮还要用它的输出"才能验到这个修复。
 *
 * ## 设计（要让结论**无懈可击**）
 *
 * 1. 往**云盘目录**里放两个文件，文件名里各带一个**只有工具输出才会有**的词
 *    （`复述：蓝鲸.txt` / `复述：11月3日.txt`）—— 这两个词**不在用户说的任何一句话里**，
 *    也不在系统提示词里（云盘文件名不会被注入提示词，这一点与"记忆"不同：记忆是会注入的）；
 * 2. 第 1 轮：`请调用 list_files 工具`，但**明确要求只回答个数、不要列名字**
 *    → **前置断言**：第 1 轮的回答里**不能出现**那两个词（否则结论不成立，测试要报出来）；
 * 3. 第 2 轮：问"刚才列出来的文件名分别是什么？"
 *    → **结论断言**：回答里**出现了**那个词 —— 那只能来自上一步工具的**输出**
 *      （它被 §163 的 `outputText` 折进了历史）。
 *
 * ## ⚠️ 2026-10-16 的两处重写（收进批跑）
 *
 * ① **标记搬进"工具输出"**。原来靠"记忆库"当那个唯一的来源 —— 而
 *    **记忆从 §164 起会注入系统提示词**了（脚本头部原来那句"记忆没有被注入，我查过了"
 *    已经过期）。注入之后，"第 2 轮答得出内容"也可能是从系统提示词里抄的，
 *    结论不再无懈可击。所以唯一来源换成**云盘文件名**：它只可能从工具输出进来。
 * ② **靠假通道驱动**（`verify-acceptances.mjs` 的 `startLocalFakeModel`）：
 *    `请调用 list_files 工具` 让它回一个真的工具调用，而**工具那一支的正文不复述 token**
 *    （见那边的说明）—— 所以第 1 轮不可能泄底，token 只可能经由"工具输出折进历史"到达第 2 轮。
 *
 * ## 变异实证（2026-10-16）
 *   把 `history.ts` 的 `outputText` 那一半摘掉（等于退回 §148：历史里只留界面那行小字、
 *   不带输出）→ 第 2 轮的请求里没有 `复述：蓝鲸` → 回复里没有「蓝鲸」→ 这一条**当场变红**。
 */
const DATA = ".verify/toolfeed-data";
if (!(await freshDir(DATA))) {
  console.error("✗ 数据目录 " + DATA + " 删不掉 —— 先手工关掉占着它的 Electron");
  process.exit(1);
}
fs.mkdirSync(path.join(DATA, "drive"), { recursive: true });

/*
 * 两条"只有工具输出里才有"的线索。
 *
 * ⚠️ 文件名里用的是**中文全角冒号 `：`**（`复述：蓝鲸`）—— Windows 文件名不许用 ASCII `:`，
 * 而假通道的「复述」标记两种冒号都认（见 `startLocalFakeModel` 里那个正则）。
 */
const SECRET_A = "蓝鲸";
const SECRET_B = "11月3日";
fs.writeFileSync(path.join(DATA, "drive", `复述：${SECRET_A}.txt`), "代号的说明\n", "utf8");
fs.writeFileSync(path.join(DATA, "drive", `复述：${SECRET_B}.txt`), "日期的说明\n", "utf8");

let PORT = 9314;
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
  /* ⚠️ 闸门设成全部允许：这一轮要**真的调工具**（默认档位会拦成「等你确认」，工具没执行就没输出） */
  await page.evaluate(() => localStorage.setItem("dsh-canvas.confirm-mode", "全部允许"));
  await page.reload();
  await page.waitForSelector('[data-testid="wb"]', { timeout: 20000 });

  const lastReply = async () => {
    await page.waitForTimeout(600);
    return page.evaluate(() => {
      const all = Array.from(document.querySelectorAll(".wb-assistant-text"));
      return all.length ? (all[all.length - 1].textContent ?? "").trim() : "";
    });
  };

  /* ── 第 1 轮：只说个数 ── */
  await page.locator('[data-testid="wb-nav-home"]').click();
  await page.waitForTimeout(700);
  /* ⚠️ 「请调用 list_files 工具」是装置标记（与工具协议本身是同一套口径，见文件头） */
  await page
    .locator('[data-testid="wb-composer-input"]')
    .fill("请调用 list_files 工具列一下我的云盘。**只告诉我一共有几个文件，不要列出任何名字。**");
  /*
   * ⚠️ 等**回合真的结束**（会话记录里的 `done`），不要"气泡一出现就读"（审计 G108 同族）：
   * 半截读法会让"第 1 轮有没有泄底"这件事被一个还没流完的字符串判掉。
   */
  let before = await finishedTurns(page);
  await page.locator('[data-testid="wb-send"]').click();
  await waitTurnEnd(page, before, 120_000);
  out.round1 = await lastReply();
  out.toolLine1 = await page.evaluate(() => {
    const all = Array.from(document.querySelectorAll(".wb-tool-line"));
    return all.length ? (all[all.length - 1].textContent ?? "").trim() : "";
  });

  /* ── 第 2 轮：问名字（只有上一步的工具输出里有）── */
  await page.locator('[data-testid="wb-composer-input"]').fill("刚才列出来的文件名分别是什么？原样说给我。");
  before = await finishedTurns(page);
  await page.locator('[data-testid="wb-send"]').click();
  await waitTurnEnd(page, before, 120_000);
  out.round2 = await lastReply();
  out.shot = await shot(page, "toolfeed.png");

  await b.close();
} catch (e) {
  out.error = String(e).slice(0, 300);
} finally {
  console.log(JSON.stringify(out, null, 2));
  await killTree(child);

  const bad = [];
  if (out.error) bad.push("异常: " + out.error);

  /* 前置：这一轮真的调了工具（不然下面那条结论根本没得谈） */
  if (!String(out.toolLine1 ?? "").includes("已完成")) {
    bad.push(`第 1 轮没有「已完成」那行留痕 —— 工具没调成：${JSON.stringify((out.toolLine1 ?? "").slice(0, 120))}`);
  }

  /* 前置：第 1 轮必须没吐出内容，否则"第 2 轮答出来"证明不了任何事 */
  const r1 = out.round1 ?? "";
  if (!r1) bad.push("第 1 轮没有回复");
  if (r1.includes(SECRET_A) || r1.includes(SECRET_B)) {
    bad.push(`第 1 轮就把内容说出来了（测试不成立，需要更严的指令）：${JSON.stringify(r1.slice(0, 120))}`);
  }

  /* 结论：第 2 轮答出了内容 —— 只能来自上一步工具的**输出** */
  const r2 = out.round2 ?? "";
  if (!r2) bad.push("第 2 轮没有回复");
  if (!(r2.includes(SECRET_A) || r2.includes(SECRET_B))) {
    bad.push(
      `第 2 轮没答出只存在于工具输出里的内容：${JSON.stringify(r2.slice(0, 160))}` +
        `（工具界面那行：${JSON.stringify((out.toolLine1 ?? "").slice(0, 80))}）`,
    );
  }

  if (bad.length) {
    console.error("✗ " + bad.join("；"));
    process.exitCode = 1;
  } else {
    console.log("✓ 工具输出进了历史：第 1 轮只说个数，第 2 轮却能原样说出那两个文件名 —— 只能来自上一步工具的输出");
  }
}
