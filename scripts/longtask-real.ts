/**
 * 10.6 的「长任务」用**真模型**跑（Phase 10.6 剩下的那半：≥50 步 / 小时级）。
 *
 * ## 与 `engine/eval/longtask.test.ts` 的分工
 *
 * 那边用**假 provider 脚本**钉结构问题（50 步走得完 / 步数对得上 / 崩溃注入怎么收场）——
 * 脚本化才可复现。这一支跑**真模型**：真实往返、真实工具、真实磁盘。
 *
 * ## 「小时级」这一条是**怎么算数的**（2026-10-16 第二版）
 *
 * 第一版给了一件"要建 30 个文件"的活，结果**只跑了 20 秒** —— 因为**件活多大是模型说了算**，
 * 我们钉不住时长。所以这一版把时长**做成活的属性**：`--minutes 60` 时，活被拆成若干轮，
 * 每轮之间让 agent 用 `run_command` **真的等**（等的是墙钟，不是假装）。
 * 这样"一小时"是我们**钉出来的**，而每一轮里的动作仍然是真模型真工具。
 *
 * ⚠️ **要真花钱**（主人放行），所以自带 `--yes-spend` 门：不加只打印计划。
 * 结果写进 `engine/eval/longtask-real.md`，数字如实记、不修饰。
 *
 * 用法：
 *   npx tsx scripts/longtask-real.ts                      # 干跑（打印计划）
 *   npx tsx scripts/longtask-real.ts --yes-spend          # 批量模式（一件要很多步的活）
 *   npx tsx scripts/longtask-real.ts --yes-spend --minutes 60   # 小时级（分批 + 真等待）
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { buildEngine } from "../hosts/cli/assembly";
import { sumUsage, usageTotal } from "../shared/cost";
import { modelInfoOf } from "../engine/runtime/models";

const OUT = path.join("engine", "eval", "longtask-real.md");

/** 批量模式：这件活**必须**用很多步（建 30 个文件 → 逐个读回 → 写汇总）。 */
const TASK_BATCH = [
  "在 work 目录里做三件事，一步都别省：",
  "① 建 30 个文本文件，名字从 note-01.txt 到 note-30.txt，每个文件里只写一行：第 N 天的记录（N 是 1..30）。",
  "② 然后把这 30 个文件逐个读回来，确认内容对不对。",
  "③ 最后写一个 summary.md：一句话说明一共几个文件、内容是否都对。",
  "要求：用工具真的做（别只在回复里说），①里每个文件单独建，不要用循环脚本一次生成。",
].join("\n");

/** 小时级模式：分批 + 真等待。轮数与每轮等待由 `--minutes` 算出来。 */
function taskPaced(rounds: number, waitSec: number): string {
  return [
    "这件事要**持续大约一小时**，按轮做，别偷懒：",
    `一共 ${rounds} 轮。每一轮做三件事：`,
    `  ① 在 work 目录里建一个文件 round-NN.txt（NN 是轮次，从 01 开始），内容写上这一轮的时间戳；`,
    `  ② 用 run_command 执行一条**真的等待**命令，等 ${waitSec} 秒（Windows：\`timeout /t ${waitSec} /nobreak\`）；`,
    `     这条命令的 timeout 参数给 ${(waitSec + 60) * 1000}（毫秒）—— 不然等待会被工具自己掐掉；`,
    "  ③ 接着做下一轮。",
    "最后一轮结束后，写一个 summary.md 记录一共做了几轮。",
    "要求：等待必须是**真的等**（别跳过、别把 timeout 参数写小），我会核对墙钟时间。",
  ].join("\n");
}

async function main(): Promise<void> {
  const yes = process.argv.includes("--yes-spend");
  const arg = (name: string, fallback: string) => {
    const i = process.argv.indexOf(`--${name}`);
    return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
  };
  const provider = arg("provider", "deepseek");
  const model = arg("model", "deepseek-chat");
  const minutes = Number(arg("minutes", "0"));
  /* 小时级：每轮 = 等 100 秒 + 做活约 20 秒 → 2 分钟一轮 */
  const paced = minutes > 0;
  const perRoundSec = 120;
  const rounds = paced ? Math.max(2, Math.round((minutes * 60) / perRoundSec)) : 0;
  const waitSec = 100;
  const steps = paced ? rounds * 6 + 4 : Number(arg("steps", "80"));

  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "dh-longtask-"));
  const storeDir = fs.mkdtempSync(path.join(os.tmpdir(), "dh-longtask-store-"));
  const work = path.join(runDir, "work");
  fs.mkdirSync(work, { recursive: true });

  const task = paced ? taskPaced(rounds, waitSec) : TASK_BATCH;
  console.log(`计划：${provider}/${model}，步数上限 ${steps}，工作目录 ${work}`);
  if (paced) {
    console.log(`小时级：${rounds} 轮 × 约 ${perRoundSec} 秒（等 ${waitSec} 秒 + 做活）≈ ${Math.round((rounds * perRoundSec) / 60)} 分钟`);
  } else {
    console.log("批量：建 30 个文件 → 逐个读回 → 写 summary.md（约 62 个工具调用）");
  }
  if (!yes) {
    console.log("⚠️ 这是**干跑**：一次请求都没发。要真跑（会花钱）请加 --yes-spend。");
    return;
  }

  const built = await buildEngine([work], storeDir);
  const started = Date.now();
  let stepsSeen = 0;
  let toolCalls = 0;
  const outcome = await built.engine.run({
    sessionId: `longtask-real-${started}`,
    provider,
    model,
    system: "你是本机上的一个执行助手：用工具真的把活做完，别只描述你会怎么做。",
    messages: [{ role: "user", content: task }],
    mode: "全部允许",
    useTools: true,
    maxSteps: steps,
    onEvent: (event) => {
      if (event.type === "step-finish") stepsSeen = Math.max(stepsSeen, event.step ?? stepsSeen);
      if (event.type === "tool-call") toolCalls += 1;
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
  const files = fs.readdirSync(work);
  const made = files.filter((f) => /^note-\d+\.txt$/.test(f)).length;
  const madeRounds = files.filter((f) => /^round-\d+\.txt$/.test(f)).length;
  const summary = files.includes("summary.md");

  const lines = [
    "# 长任务（真模型）—— Phase 10.6 的另一半",
    "",
    "> 由 `npx tsx scripts/longtask-real.ts --yes-spend [--minutes 60]` 生成。**这一份要真花钱**。",
    "> 结构那半（50 步走得完 / 步数对得上 / 崩溃注入）在 `engine/eval/longtask.test.ts`，用假 provider 跑。",
    "",
    `生成时间：${new Date().toISOString()}`,
    `模式：${paced ? `小时级（${rounds} 轮 × 约 ${perRoundSec} 秒）` : "批量（建 30 文件 → 读回 → 汇总）"}`,
    "",
    "| 项 | 值 |",
    "|---|---|",
    `| 通道 | ${provider} / ${model} |`,
    `| 结局 | ${outcome.ok ? "成功" : `失败：${outcome.error ?? "?"}`} |`,
    `| 步数 | ${stepsSeen}（上限 ${steps}） |`,
    `| 工具调用 | ${toolCalls} 次 |`,
    `| 耗时 | ${Math.round(ms / 1000)} 秒（${(ms / 60000).toFixed(1)} 分钟） |`,
    `| tokens | ${total ?? "?"}（in ${usage?.inputTokens ?? "?"} / out ${usage?.outputTokens ?? "?"}） |`,
    `| 花费 | ${cost === null ? "**未知**（目录表没这条模型的单价）" : `$${cost.toFixed(4)}`} |`,
    `| 磁盘上的结果 | ${paced ? `round-NN.txt **${madeRounds}/${rounds}**` : `note-01..30 **${made}/30**`}；summary.md ${summary ? "有" : "没有"} |`,
    "",
    "## 如实记下的边界",
    "",
    "1. **「小时级」是这一支脚本钉住的**（分批 + 每轮真等），不是模型的自觉；",
    "   每一轮里仍是真模型真工具。所以它证的是「装置撑得住一小时的活」。",
    "2. 时长、步数与件活都由**这一支脚本**定：换任务、换模型，数字都会变。",
    "3. 「做完了」的判据只看**磁盘**（文件在不在、几轮），不看回复里怎么写。",
    "",
  ].join("\n");
  fs.writeFileSync(OUT, lines, "utf8");

  console.log(lines);
  console.log(`记录已写入 ${OUT}`);
  built.close();
  fs.rmSync(storeDir, { recursive: true, force: true });
}

void main();
