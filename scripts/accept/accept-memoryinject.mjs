import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";
import { NO_PAGE_HINT, bootApp, connectWithRetry, freshDir, killTree, shot, waitForPage } from "./harness.mjs";

/**
 * 验收：**长期记忆真的注入了系统提示词**（§164）。
 *
 * ## 为什么必须真调模型
 *
 * `memoryPromptBlock` 有单测（25 条），但"**模型因此知道**"只能真问一次。
 * 这一条要证的是一件很具体的事：
 *
 * > 工具描述里一直写着「之后每次对话都会自动带上」，而 `memoryPromptBlock`
 * > **从来没被调用过** —— 描述与现状不一致。这一轮补上，并把它钉住。
 *
 * ## 设计
 *
 * 1. 直接往记忆库里塞一条**模型不可能从别处知道**的事实（「我叫阿岩」）；
 * 2. 问「我叫什么」，并**明确要求不要调用任何工具**；
 * 3. **结论断言**：回答里有「阿岩」 —— 没注入的话它无从知道；
 * 4. **前置断言**：这一轮**没有工具留痕** —— 否则可能是它自己调 `memory_list` 查出来的，
 *    那样就证明不了"注入"。
 *
 * ⚠️ 会真调模型（1 次）。
 */
const DATA = ".verify/memoryinject-data";
if (!(await freshDir(DATA))) {
  console.error("✗ 数据目录 " + DATA + " 删不掉 —— 先手工关掉占着它的 Electron");
  process.exit(1);
}
fs.mkdirSync(DATA, { recursive: true });

/** 只有注入才可能被模型知道的记忆（形状按 `MemoryEntry`：id/text/createdAt/source）。 */
const FACT = "用户的称呼是阿岩";
fs.writeFileSync(
  path.join(DATA, "memory.json"),
  JSON.stringify(
    {
      entries: [
        { id: "m1", text: FACT, createdAt: new Date().toISOString(), source: "manual" },
        { id: "m2", text: "他只用简体中文回答", createdAt: new Date().toISOString(), source: "manual" },
      ],
    },
    null,
    2,
  ),
  "utf8",
);

/* ⚠️ 2026-10-16（审计 G06/G07）：bootApp 会换端口重试 —— 下面用的是它返回的实际端口，不再假设给哪个就用哪个 */
let PORT = 9315;
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

  await page.locator('[data-testid="wb-nav-home"]').click();
  await page.waitForTimeout(700);
  await page
    .locator('[data-testid="wb-composer-input"]')
    .fill("我叫什么？**不要调用任何工具**，直接凭你已经知道的信息回答，只回答称呼本身。");
  await page.locator('[data-testid="wb-send"]').click();

  const deadline = Date.now() + 90000;
  let reply = "";
  let stable = 0;
  while (Date.now() < deadline) {
    await page.waitForTimeout(2000);
    const now = await page.evaluate(() => {
      const all = Array.from(document.querySelectorAll(".wb-assistant-text"));
      return all.length ? (all[all.length - 1].textContent ?? "").trim() : "";
    });
    if (now && now === reply) {
      stable += 1;
      if (stable >= 2) break;
    } else {
      stable = 0;
      reply = now;
    }
  }
  out.reply = reply;
  out.toolLines = await page.evaluate(() =>
    Array.from(document.querySelectorAll(".wb-tool-line")).map((e) => (e.textContent ?? "").trim()),
  );
  out.shot = await shot(page, "memory-inject.png");

  await b.close();
} catch (e) {
  out.error = String(e).slice(0, 300);
} finally {
  console.log(JSON.stringify(out, null, 2));
  await killTree(child);

  const bad = [];
  if (out.error) bad.push("异常: " + out.error);

  /* 前置：这一轮不许有工具留痕（否则可能是它自己查出来的） */
  if ((out.toolLines ?? []).length > 0) {
    bad.push(`这一轮调了工具（测试不成立）：${JSON.stringify(out.toolLines)}`);
  }

  /* 结论：没注入的话，它无从知道这个称呼 */
  if (!(out.reply ?? "").includes("阿岩")) {
    bad.push(`回答里没有「阿岩」—— 记忆没进系统提示词：${JSON.stringify((out.reply ?? "").slice(0, 160))}`);
  }

  if (bad.length) {
    console.error("✗ " + bad.join("；"));
    process.exitCode = 1;
  } else {
    console.log("✓ 记忆注入成立：没调任何工具，它却知道只存在于记忆库里的称呼 —— 只能来自系统提示词");
  }
}
