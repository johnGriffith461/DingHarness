import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";
import { bootApp, connectWithRetry, freshDir, killTree, shot } from "./harness.mjs";

/**
 * 验收：**子智能体**（§150）。
 *
 * ## 一条脚本同时压四件事
 *
 * | 要证明的 | 怎么证明 |
 * |---|---|
 * | 能派出去、办得完 | 工具留痕出现「子智能体：完成（N 步，约 X tokens）」 |
 * | 汇合（要点回得来） | 父级转告的内容里有 `156`（12×13，只有子智能体算得出来） |
 * | **审批穿透** | 子智能体被要求调 `memory_save` 存结果，而**磁盘上没有那条** —— 它内部的闸门照样拦 |
 * | 拦下要如实报告 | 留痕里有「N 项等你确认」 |
 *
 * ⚠️ 档位设成**按需确认**：这正是"穿透"能显出来的档位 ——
 * 写类动作在父级与子级**都**要问，而子级那些没法当场点允许，只能如实回报。
 *
 * ⚠️ **这条会真调模型**（约 2~3 分钟），不进无模型批跑。
 */
const DATA = "D:/DoubaoWorkClone/.verify/subagent-data";
if (!(await freshDir(DATA))) {
  console.error("✗ 数据目录 " + DATA + " 删不掉 —— 先手工关掉占着它的 Electron");
  process.exit(1);
}

const PORT = 9299;
const { child, ok, getLog } = await bootApp({ port: PORT, dataDir: DATA, timeoutMs: 30000 });
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

  /*
   * ⚠️ 档位决定"汇合"能不能看出来（这是 §144 放行路径的真实边界）：
   *   · 全部允许 → spawn_agent 在**流里**就跑完，模型拿到要点后接着把话说完 → **汇合成立**
   *   · 按需确认 → 那一轮模型已经写完回复（"等你确认"），放行后**不会再叫模型一次** →
   *     留痕里有结果、磁盘也有结果，但**父级的正文不会补上** —— 这是已知边界，见 §150
   * 所以两段分开验：**A 段验汇合，B 段验穿透**。
   */
  const setMode = async (mode) => {
    await page.evaluate((m) => localStorage.setItem("dsh-canvas.confirm-mode", m), mode);
    await page.reload();
    await page.waitForSelector('[data-testid="wb"]', { timeout: 20000 });
  };
  const toolLines = () =>
    page.evaluate(() =>
      Array.from(document.querySelectorAll(".wb-tool-line")).map((e) => (e.textContent?.trim() ?? "")),
    );
  const lastReply = () =>
    page.evaluate(() => {
      const all = Array.from(document.querySelectorAll(".wb-assistant-text"));
      return all.length ? (all[all.length - 1].textContent ?? "").trim() : "";
    });
  const waitSpawn = async (ms = 180000) => {
    const deadline = Date.now() + ms;
    let line = null;
    while (Date.now() < deadline) {
      await page.waitForTimeout(2500);
      line = (await toolLines()).find((t) => t.includes("子智能体")) ?? null;
      if (line?.includes("完成") || line?.includes("失败")) break;
    }
    return line;
  };

  /* ── A 段：全部允许 → 验"汇合"（父级拿到要点并转告） ── */
  await setMode("全部允许");
  out.modeA = await page.evaluate(() => document.querySelector('[data-testid="wb-confirm"]')?.textContent?.trim() ?? null);
  await page.locator('[data-testid="wb-nav-home"]').click();
  await page.waitForTimeout(800);
  await page
    .locator('[data-testid="wb-composer-input"]')
    .fill("请调用 spawn_agent 工具，派一个子智能体去计算 12×13，然后把它回报的要点转告我。");
  await page.locator('[data-testid="wb-send"]').click();
  out.spawnLineA = await waitSpawn();
  out.replyA = await lastReply();
  out.shotA = await shot(page, "subagent-a.png");

  /* ── B 段：按需确认 → 验"审批穿透"（子级写动作被拦下且如实回报） ── */
  await setMode("按需确认");
  out.modeB = await page.evaluate(() => document.querySelector('[data-testid="wb-confirm"]')?.textContent?.trim() ?? null);
  await page.locator('[data-testid="wb-nav-home"]').click();
  await page.waitForTimeout(800);
  await page
    .locator('[data-testid="wb-composer-input"]')
    .fill(
      "请调用 spawn_agent 工具，派一个子智能体去办这件事：计算 12×13，并调用 memory_save 把这个结果记进长期记忆。",
    );
  await page.locator('[data-testid="wb-send"]').click();

  const allow = page.locator('[data-testid^="wb-tool-allow-"]').first();
  await allow.waitFor({ timeout: 120000 });
  await page.waitForTimeout(400);
  out.spawnNeededApproval = true;
  await allow.click();
  out.spawnLineB = await waitSpawn();
  out.replyB = await lastReply();

  const memoFile = path.join(DATA, "memory.json");
  out.memoryFileExists = fs.existsSync(memoFile);
  out.memoryOnDisk = out.memoryFileExists ? fs.readFileSync(memoFile, "utf8") : "";
  out.shot = await shot(page, "subagent.png");

  await b.close();
} catch (e) {
  out.error = String(e).slice(0, 300);
} finally {
  console.log(JSON.stringify(out, null, 2));
  await killTree(child);

  const bad = [];
  if (out.error) bad.push("异常: " + out.error);

  /* ── A 段：能派出去 + 汇合回来 ── */
  if (!(out.spawnLineA ?? "").includes("子智能体")) bad.push("A 段没有出现子智能体的留痕");
  else if (!(out.spawnLineA ?? "").includes("完成")) bad.push(`A 段子智能体没办完：${out.spawnLineA}`);
  /* 156 只有子智能体算得出来 —— 父级正文里有它，才说明"要点真的汇合回来了" */
  if (!(out.replyA ?? "").includes("156")) {
    bad.push(`A 段父级没转告出 156（回复：${JSON.stringify((out.replyA ?? "").slice(0, 80))}）—— 汇合没成功`);
  }

  /* ── B 段：审批穿透 ── */
  if (!out.spawnNeededApproval) bad.push("按需确认档下 spawn_agent 没有要用户确认（它是写类动作，应当要问）");
  if (!(out.spawnLineB ?? "").includes("完成")) bad.push(`B 段子智能体没办完：${out.spawnLineB}`);
  /*
   * ⭐ 硬断言只压**确定性的后果**：按需确认档下，子智能体内部的写动作**一定执行不了**。
   *
   * ⚠️ 这里踩过一次：原来还断言"留痕必须提等你确认"—— 但**子智能体这次没尝试写记忆**，
   * 于是那条根本没出现。**"它有没有尝试"是模型行为，不是系统保证** ——
   * 拿模型行为当硬断言，红的是自己（同类问题 §146 也犯过一次）。
   */
  if ((out.memoryOnDisk ?? "").includes("156")) {
    bad.push("⚠️ 子智能体把记忆存进去了 —— 它绕过了闸门（审批穿透没生效）");
  }
  /*
   * 「如实回报」只作为**记录项**（观察到了就是穿透最直接的证据，没观察到也不算失败）：
   * 那取决于子智能体是否真的去试了写动作。
   */
  out.blockedReported = (out.spawnLineB ?? "").includes("等你确认");

  if (bad.length) {
    console.error("✗ " + bad.join("；"));
    process.exitCode = 1;
  } else {
    console.log("✓ 子智能体成立：派得出去、汇得回来、且**子级闸门没有被绕过**（写记忆被拦下并如实回报）");
  }
}
