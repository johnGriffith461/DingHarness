/**
 * 10.6 的「长任务」用**真模型**跑一遍（Phase 10.6 剩下的那半：≥50 步 / 小时级）。
 *
 * ## 与 `engine/eval/longtask.test.ts` 的分工
 *
 * 那边用**假 provider 脚本**钉的是"50 步走得完、步数对得上、每步留痕、崩溃注入怎么收场" ——
 * 那些是**结构**问题，脚本化才可复现。这一支跑的是**真模型**：同样一件需要很多步的活，
 * 看它在真实往返、真实工具、真实磁盘下要多久、要多少 token、会不会半路跑偏。
 *
 * ⚠️ 这件事**要真花钱**（主人 2026-10-16 放行），所以脚本自己带一道 `--yes-spend`：
 * 不加只打印计划。跑出来的数字写进 `engine/eval/longtask-real.md`，不修饰。
 *
 * 用法：`npx tsx scripts/longtask-real.ts --yes-spend [--steps 80] [--provider deepseek] [--model deepseek-chat]`
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { buildEngine } from "../hosts/cli/assembly";
import { sumUsage, usageTotal } from "../shared/cost";
import { modelInfoOf } from "../engine/runtime/models";

const OUT = path.join("engine", "eval", "longtask-real.md");

/** 这件活**必须**用很多步：建 30 个文件 → 逐个读回来核对 → 写一份汇总。 */
const TASK = [
  "在 work 目录里做三件事，一步都别省：",
  "① 建 30 个文本文件，名字从 note-01.txt 到 note-30.txt，每个文件里只写一行：第 N 天的记录（N 是 1..30）。",
  "② 然后把这 30 个文件逐个读回来，确认内容对不对。",
  "③ 最后写一个 summary.md：一句话说明一共几个文件、内容是否都对。",
  "要求：用工具真的做（别只在回复里说），①里每个文件单独建，不要用循环脚本一次生成。",
].join("\n");

async function main(): Promise<void> {
  const yes = process.argv.includes("--yes-spend");
  const arg = (name: string, fallback: string) => {
    const i = process.argv.indexOf(`--${name}`);
    return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
  };
  const provider = arg("provider", "deepseek");
  const model = arg("model", "deepseek-chat");
  const steps = Number(arg("steps", "80"));
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "dh-longtask-"));
  const storeDir = fs.mkdtempSync(path.join(os.tmpdir(), "dh-longtask-store-"));
  const work = path.join(runDir, "work");
  fs.mkdirSync(work, { recursive: true });

  console.log(`计划：${provider}/${model}，步数上限 ${steps}，工作目录 ${work}`);
  console.log(`活：建 30 个文件 → 逐个读回 → 写 summary.md（大约 ${30 + 30 + 2} 个工具调用）`);
  if (!yes) {
    console.log("⚠️ 这是**干跑**：一次请求都没发。要真跑（会花钱）请加 --yes-spend。");
    return;
  }

  const built = await buildEngine([work], storeDir);
  const started = Date.now();
  let stepsSeen = 0;
  let text = "";
  const toolCalls: string[] = [];

  const outcome = await built.engine.run({
    sessionId: `longtask-real-${started}`,
    provider,
    model,
    system: "你是本机上的一个执行助手：用工具真的把活做完，别只描述你会怎么做。",
    messages: [{ role: "user", content: TASK }],
    mode: "全部允许",
    useTools: true,
    maxSteps: steps,
    onEvent: (event) => {
      if (event.type === "step-finish") stepsSeen = Math.max(stepsSeen, event.step ?? stepsSeen);
      if (event.type === "text") text += event.text;
      if (event.type === "tool-call") toolCalls.push(event.toolName);
    },
  });

  const ms = Date.now() - started;
  const usage = sumUsage(
    outcome.events.filter((e) => e.type === "done").map((e) => (e.type === "done" ? e.usage : undefined)),
  );
  const total = usageTotal(usage);
  const info = modelInfoOf(model);
  const cost =
    info.priceIn !== undefined && info.priceOut !== undefined && usage
      ? ((usage.inputTokens ?? 0) / 1e6) * info.priceIn + ((usage.outputTokens ?? 0) / 1e6) * info.priceOut
      : null;

  /* 磁盘上的**结果**才算数（不认"回复里说做完了"） */
  const made = fs.readdirSync(work).filter((f) => /^note-\d+\.txt$/.test(f)).length;
  const summary = fs.existsSync(path.join(work, "summary.md"));

  const lines = [
    "# 长任务（真模型）—— Phase 10.6 的另一半",
    "",
    "> 由 `npx tsx scripts/longtask-real.ts --yes-spend` 生成。**这一份要真花钱**，所以默认干跑。",
    "> 结构那半（50 步走得完 / 步数对得上 / 崩溃注入）在 `engine/eval/longtask.test.ts`，用假 provider 跑。",
    "",
    `生成时间：${new Date().toISOString()}`,
    "",
    "| 项 | 值 |",
    "|---|---|",
    `| 通道 | ${provider} / ${model} |`,
    `| 结局 | ${outcome.ok ? "成功" : `失败：${outcome.error ?? "?"}`} |`,
    `| 步数 | ${stepsSeen}（上限 ${steps}） |`,
    `| 工具调用 | ${toolCalls.length} 次 |`,
    `| 耗时 | ${Math.round(ms / 1000)} 秒（${(ms / 60000).toFixed(1)} 分钟） |`,
    `| tokens | ${total ?? "?"}（in ${usage?.inputTokens ?? "?"} / out ${usage?.outputTokens ?? "?"}） |`,
    `| 花费 | ${cost === null ? "**未知**（目录表没这条模型的单价）" : `$${cost.toFixed(4)}`} |`,
    `| 磁盘上的结果 | note-01..30 **做出 ${made}/30**；summary.md ${summary ? "有" : "没有"} |`,
    "",
    "## 如实记下的边界",
    "",
    "1. **它是不是「小时级」由上面的耗时说话** —— 不是由愿望说话。没到一小时就写没到。",
    "2. 步数上限与这件活都是**这一支脚本**定的：换个任务、换个模型，数字都会变。",
    "3. 「做完了」的判据只看**磁盘**（文件在不在），不看回复里怎么写。",
    "",
  ].join("\n");
  fs.writeFileSync(OUT, lines, "utf8");

  console.log(lines);
  console.log(`记录已写入 ${OUT}`);
  built.close();
  fs.rmSync(storeDir, { recursive: true, force: true });
}

void main();
