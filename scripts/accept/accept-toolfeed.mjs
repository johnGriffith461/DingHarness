import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";
import { NO_PAGE_HINT, bootApp, connectWithRetry, freshDir, killTree, shot, waitForPage } from "./harness.mjs";

/**
 * 验收：**工具输出真的进了对话历史**（§163）。
 *
 * ## 为什么单独一条（并且必须真调模型）
 *
 * `withToolLines` 的行为有单测，但"**模型因此答得出来**"只能真问一次。
 * 而且这件事**跨轮才看得出**：同一轮里 AI SDK 自己会把工具结果喂回去，
 * 所以只有"上一轮调的工具、下一轮还要用它的输出"才能验到这个修复。
 *
 * ## 设计（要让结论**无懈可击**）
 *
 * 1. 直接往 `memory.json` 里塞两条**模型不可能从别处知道**的记忆；
 * 2. 第 1 轮：让它调 `memory_list`，但**明确要求只回答条数、不要列内容**；
 *    → **前置断言**：第 1 轮的回答里**不能出现**记忆内容（否则结论不成立，测试要报出来）；
 * 3. 第 2 轮：问"刚才列出来的两条分别是什么？"
 *    → **结论断言**：回答里**出现了**记忆内容 —— 那只能来自上一步工具的**输出**。
 *
 * （记忆**没有**被注入系统提示词，这一条我查过了 —— 否则第 2 轮能从系统提示词里抄到，
 *   结论就不成立了。）
 *
 * ⚠️ 会真调模型（2 次）。
 */
const DATA = ".verify/toolfeed-data";
if (!(await freshDir(DATA))) {
  console.error("✗ 数据目录 " + DATA + " 删不掉 —— 先手工关掉占着它的 Electron");
  process.exit(1);
}
fs.mkdirSync(DATA, { recursive: true });

/** 两条"只有工具输出里才有"的记忆。 */
const SECRET_A = "项目代号是蓝鲸";
const SECRET_B = "交付日是 11 月 3 日";
/*
 * ⚠️ 形状是 `{ entries: [...] }`，**不是裸数组** ——
 * 第一版我写成裸数组，`normalizeMemory` 就把它规整成了空库，
 * 于是工具如实报"当前 0 条"，模型也就老老实实说 0 条（它是对的，是我造的数据不对）。
 * （和 §157 那次 `origin 由目录决定` 同一类错：**造 fixtures 前先把系统的形状读一遍**。）
 */
fs.writeFileSync(
  path.join(DATA, "memory.json"),
  JSON.stringify(
    { entries: [{ id: "m1", text: SECRET_A }, { id: "m2", text: SECRET_B }] },
    null,
    2,
  ),
  "utf8",
);

const PORT = 9314;
const { child, ok, getLog } = await bootApp({ port: PORT, dataDir: DATA, timeoutMs: 30000 });
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

  /** 等一段助手回复（最后一条）稳定下来。 */
  const lastReply = async (deadlineMs) => {
    const deadline = Date.now() + deadlineMs;
    let text = "";
    let stable = 0;
    while (Date.now() < deadline) {
      await page.waitForTimeout(2000);
      const now = await page.evaluate(() => {
        const all = Array.from(document.querySelectorAll(".wb-assistant-text"));
        return all.length ? (all[all.length - 1].textContent ?? "").trim() : "";
      });
      if (now && now === text) {
        stable += 1;
        if (stable >= 2) return now;
      } else {
        stable = 0;
        text = now;
      }
    }
    return text;
  };

  /* ── 第 1 轮：只说条数 ── */
  await page.locator('[data-testid="wb-nav-home"]').click();
  await page.waitForTimeout(700);
  await page
    .locator('[data-testid="wb-composer-input"]')
    .fill("看一下我记住了什么。**只告诉我一共有几条，不要列出任何一条的内容。**");
  await page.locator('[data-testid="wb-send"]').click();
  out.round1 = await lastReply(90000);
  out.toolLine1 = await page.evaluate(() => {
    const all = Array.from(document.querySelectorAll(".wb-tool-line"));
    return all.length ? (all[all.length - 1].textContent ?? "").trim() : "";
  });

  /* ── 第 2 轮：问内容（只有上一步的工具输出里有）── */
  await page.locator('[data-testid="wb-composer-input"]').fill("刚才列出来的两条分别是什么？原样说给我。");
  await page.locator('[data-testid="wb-send"]').click();
  out.round2 = await lastReply(90000);
  out.shot = await shot(page, "toolfeed.png");

  await b.close();
} catch (e) {
  out.error = String(e).slice(0, 300);
} finally {
  console.log(JSON.stringify(out, null, 2));
  await killTree(child);

  const bad = [];
  if (out.error) bad.push("异常: " + out.error);

  /* 前置：第 1 轮必须没吐出内容，否则"第 2 轮答出来"证明不了任何事 */
  const r1 = out.round1 ?? "";
  if (!r1) bad.push("第 1 轮没有回复");
  if (r1.includes("蓝鲸") || r1.includes("11 月 3 日")) {
    bad.push(`第 1 轮就把内容说出来了（测试不成立，需要更严的指令）：${JSON.stringify(r1.slice(0, 120))}`);
  }

  /* 结论：第 2 轮答出了内容 —— 只能来自上一步工具的**输出** */
  const r2 = out.round2 ?? "";
  if (!r2) bad.push("第 2 轮没有回复");
  if (!(r2.includes("蓝鲸") || r2.includes("11 月 3 日"))) {
    bad.push(
      `第 2 轮没答出只存在于工具输出里的内容：${JSON.stringify(r2.slice(0, 160))}` +
        `（工具界面那行：${JSON.stringify((out.toolLine1 ?? "").slice(0, 80))}）`,
    );
  }

  if (bad.length) {
    console.error("✗ " + bad.join("；"));
    process.exitCode = 1;
  } else {
    console.log("✓ 工具输出进了历史：第 1 轮只说条数，第 2 轮却能原样说出那两条 —— 只能来自上一步工具的输出");
  }
}
