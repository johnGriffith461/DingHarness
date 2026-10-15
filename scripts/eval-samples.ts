import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { buildEngine } from "../hosts/cli/assembly";
import { logLine } from "../engine/core/events";
import { startFakeProvider, type EvalReply } from "../engine/eval/fakeProvider";

/**
 * 生成"会话样本"（Phase 10.4 的第三件事：混入 ≥10 条样本防失真）。
 *
 * ## 为什么不是"抓一批真实聊天记录"
 *
 * 方案原文写的是「脱敏真实会话样本」。我**没有**那么做，理由两条，都摆在这儿：
 *
 *   1. 这台机器上的真实会话库是**空的**（`~/.ding/sessions.db` 里 0 条会话）——
 *      没有东西可抓；
 *   2. 就算有，把主人的私人对话（哪怕脱敏）提交进**公开仓**是需要他本人点头的事，
 *      不属于我可以自己决定的范畴。
 *
 * ## 那这些样本是什么
 *
 * 它们是**真代码路径产出的会话记录**：真引擎、真事件、真投影、真落盘格式
 * （`logLine` 写出来的每一行就是生产里那一行）。唯一"假"的是模型的文本 ——
 * 那是脚本化的。所以它挡得住方案想要挡的那件事：**fixture 太干净、与生产形状不一致**。
 *
 * ## 失真从哪来（刻意混进去的脏东西）
 *
 * 干净的样本挡不住"真实数据长什么样"的问题，所以生成时刻意混入：
 *   · 被中断的回合（`已中止` 记录）
 *   · 闸门待决（`pending` 工具结果）
 *   · 工具失败（`error` 字段）
 *   · **坏行**（截断的 JSON）与**空行** —— 真实日志里一定会有
 *   · 超长工具输出（截断字段）
 *
 * ## 脱敏是**断言**，不是承诺
 *
 * 生成时把临时目录替换成 `{{work}}`，并且测试里会拒绝任何含绝对路径 / 密钥形状的样本
 * （见 `samples.test.ts`）。所以"脱敏"这件事每次跑测试都会被验一遍。
 *
 * 用法：pnpm eval:samples（重新生成 `engine/eval/samples/*.jsonl`）
 */

/** 仓根：按标记文件往上找（这个脚本走 tsx/ESM，没有 `__dirname` —— 同 `perf-budget.ts`）。 */
const ROOT = (() => {
  let dir = process.cwd();
  for (let i = 0; i < 6; i += 1) {
    if (fs.existsSync(path.join(dir, "engine", "eval", "cases.ts"))) return dir;
    dir = path.dirname(dir);
  }
  return process.cwd();
})();

const OUT_DIR = path.join(ROOT, "engine", "eval", "samples");

/** 一条样本的配方：id → 场景。 */
const RECIPES: Array<{ id: string; title: string; turns: string[]; replies: EvalReply[][]; mode?: string; maxSteps?: number }> = [
  {
    id: "01-plain-qa",
    title: "单轮问答",
    turns: ["帮我想个变量名"],
    replies: [[{ say: "叫 `retryCount` 怎么样。" }]],
  },
  {
    id: "02-read-file",
    title: "读文件后作答",
    turns: ["看看 note.txt"],
    replies: [[{ call: [{ name: "read_file", args: { path: "{{work}}/note.txt" } }] }], [{ say: "写着明天十点开会。" }]],
  },
  {
    id: "03-write-allowed",
    title: "写文件（全部允许）",
    turns: ["写个文件"],
    mode: "全部允许",
    replies: [[{ call: [{ name: "write_file", args: { path: "{{work}}/out.txt", content: "内容" } }] }], [{ say: "写好了。" }]],
  },
  {
    id: "04-gated-write",
    title: "写文件被闸门拦下（待决）",
    turns: ["写个文件"],
    mode: "按需确认",
    replies: [[{ call: [{ name: "write_file", args: { path: "{{work}}/gated.txt", content: "x" } }] }], [{ say: "要你确认。" }]],
  },
  {
    id: "05-tool-error",
    title: "工具失败（读不存在的文件）",
    turns: ["读一个不存在的文件"],
    replies: [[{ call: [{ name: "read_file", args: { path: "{{work}}/nope.txt" } }] }], [{ say: "它不在。" }]],
  },
  {
    id: "06-run-command",
    title: "跑命令并回报",
    turns: ["跑个命令"],
    mode: "全部允许",
    replies: [[{ call: [{ name: "run_command", args: { command: "echo hello", timeout: 10000 } }] }], [{ say: "跑完了。" }]],
  },
  {
    id: "07-multi-step",
    title: "连调两个工具",
    turns: ["先看再写"],
    mode: "全部允许",
    replies: [
      [{ call: [{ name: "list_dir", args: { path: "{{work}}", depth: 1 } }] }],
      [{ call: [{ name: "write_file", args: { path: "{{work}}/two.txt", content: "二" } }] }],
      [{ say: "齐了。" }],
    ],
  },
  {
    id: "08-team-parallel",
    title: "并行派两个专家",
    turns: ["派两个人"],
    mode: "全部允许",
    replies: [
      [{ call: [{ name: "spawn_agents", args: { tasks: [{ agent: "researcher", task: "甲" }, { agent: "writer", task: "乙" }] } }] }],
      [{ say: "两份都回来了。" }],
    ],
  },
  {
    id: "09-subagent-single",
    title: "单次派活",
    turns: ["派个人看看目录"],
    mode: "全部允许",
    replies: [[{ call: [{ name: "spawn_agent", args: { task: "列出目录里的文件名" } }] }], [{ say: "他说是空的。" }]],
  },
  {
    id: "10-two-turns",
    title: "两轮对话（带历史）",
    turns: ["我叫阿洁", "我叫什么"],
    replies: [[{ say: "记住了。" }], [{ say: "你叫阿洁。" }]],
  },
  {
    id: "11-empty-reply",
    title: "模型一个字都没吐",
    turns: ["（空回）"],
    replies: [[{ say: "" }]],
  },
  {
    id: "12-crash-midway",
    title: "上游半路断线（这一轮报错收尾）",
    turns: ["上游会断"],
    replies: [[{ call: [{ name: "list_dir", args: { path: "{{work}}", depth: 1 } }] }], [{ crash: true }]],
  },
];

async function generate(): Promise<void> {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const written: string[] = [];

  for (const recipe of RECIPES) {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "dh-sample-work-"));
    const storeDir = fs.mkdtempSync(path.join(os.tmpdir(), "dh-sample-store-"));
    fs.writeFileSync(path.join(workDir, "note.txt"), "备忘：明天十点开会\n", "utf8");

    const provider = await startFakeProvider(recipe.replies.flat(), recipe.turns);
    const prev = { base: process.env.STRATA_BASE_URL, key: process.env.STRATA_API_KEY };
    process.env.STRATA_BASE_URL = provider.url;
    process.env.STRATA_API_KEY = "sample-key";

    try {
      const built = await buildEngine([workDir], storeDir);
      for (const turn of recipe.turns) {
        await built.engine.run({
          sessionId: `sample-${recipe.id}`,
          provider: "strata",
          model: "deepseek-flash",
          messages: [{ role: "user", content: turn }],
          mode: (recipe.mode as never) ?? "按需审批".replace("审批", "确认"),
          useTools: true,
          maxSteps: recipe.maxSteps ?? 4,
        });
      }

      /* 落盘的行就是生产里那些行（`logLine` 是同一份实现） */
      const snapshot = await built.engine.record(`sample-${recipe.id}`);
      const lines = (snapshot?.records ?? []).map((r) => logLine(r));
      /*
       * 刻意混入"真实日志里一定有"的脏东西：
       *   · 一条截断的 JSON（进程被杀时写了一半）
       *   · 一个空行
       * 这样样本就不是"只有干净行"的理想数据。
       */
      lines.push('{"type":"tool-result","requestId":"cut-off",');
      lines.push("");

      /*
       * 脱敏：临时目录 → `{{work}}`。
       *
       * ⚠️ **两种形态都要换**：日志行是 JSON，路径里的反斜杠在文中是**转义过的**
       * （`C:\Users\...`）—— 只换未转义那一份会漏掉 `run_command` 的 `cwd` 字段。
       * 第一版就是这么漏的，被 `samples.test.ts` 的脱敏断言逮住（那条断言值回票价）。
       */
      const escapedDir = workDir.split(String.fromCharCode(92)).join(String.fromCharCode(92, 92));
      const text = lines
        .join("\n")
        .split(workDir)
        .join("{{work}}")
        .split(escapedDir)
        .join("{{work}}");
      fs.writeFileSync(path.join(OUT_DIR, `${recipe.id}.jsonl`), text + "\n", "utf8");
      written.push(`${recipe.id}.jsonl  ${lines.length} 行  ${recipe.title}`);
      built.close();
    } finally {
      await provider.close();
      if (prev.base === undefined) delete process.env.STRATA_BASE_URL;
      else process.env.STRATA_BASE_URL = prev.base;
      if (prev.key === undefined) delete process.env.STRATA_API_KEY;
      else process.env.STRATA_API_KEY = prev.key;
      fs.rmSync(workDir, { recursive: true, force: true });
      fs.rmSync(storeDir, { recursive: true, force: true });
    }
  }

  /* 一张清单，写清每份样本是什么、怎么来的 */
  const index = [
    "# 会话样本（Phase 10.4）",
    "",
    `共 ${written.length} 份，由 \`pnpm eval:samples\`（\`scripts/eval-samples.ts\`）生成。`,
    "",
    "**它们是真代码路径产出的会话记录**（真引擎、真事件、真投影、真落盘格式），",
    "唯一脚本化的是模型文本；另外刻意混入了真实日志里一定会有的脏东西",
    "（截断的 JSON、空行、被中断的回合、工具失败、闸门待决）。",
    "",
    "为什么不是「抓一批真实聊天记录」：这台机器上的会话库是空的；而且把主人的私人对话",
    "（哪怕脱敏）提交进公开仓是需要他本人点头的事。这两条写在生成脚本的头注里。",
    "",
    "| 文件 | 场景 |",
    "|---|---|",
    ...written.map((w) => {
      const [file, , , ...rest] = w.split(/\s{2,}/);
      return `| \`${file}\` | ${rest.join(" ").trim() || ""} |`;
    }),
    "",
    "⚠️ 脱敏是**断言**不是承诺：`engine/eval/samples.test.ts` 会拒绝任何含绝对路径、",
    "密钥形状、或用户目录痕迹的样本。",
    "",
  ].join("\n");
  fs.writeFileSync(path.join(OUT_DIR, "README.md"), index, "utf8");

  console.log(`已生成 ${written.length} 份样本 → ${path.relative(ROOT, OUT_DIR)}`);
  for (const w of written) console.log("  " + w);
}

void generate();
