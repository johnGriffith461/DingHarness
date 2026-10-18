/**
 * SWE-bench 预测生成（V6-1a）。
 *
 * ## 它产出什么
 *
 * 官方格式的预测文件（一行一条）：
 *
 * ```json
 * {"instance_id":"django__django-11099","model_name_or_path":"ding/…","model_patch":"diff --git …"}
 * ```
 *
 * 然后交给**官方 harness** 判分（Docker 环境按仓库/版本起）：
 *
 * ```bash
 * python -m swebench.harness.run_evaluation \
 *   --predictions_path predictions.jsonl \
 *   --swe_bench_tasks princeton-nlp/SWE-bench_Verified \
 *   --run_id ding-v6
 * ```
 *
 * ## 为什么不在这个脚本里判分
 *
 * 官方判分要按每个仓库的版本起对应镜像、装依赖、跑 FAIL_TO_PASS/PASS_TO_PASS。
 * 自己写一套"差不多"的判分，得到的数字**不能与公开榜对表** —— 那就失去公开基准的意义。
 *
 * ## 花钱与安全
 *
 * 真模型跑 500 条 Verified 是很贵的，所以：
 *   · 必须显式 `--yes-spend`（不给只打印计划并退出 2）；
 *   · `--limit` 先跑 1 条验证通路；
 *   · agent 在克隆出来的临时仓库里跑 `run_command` —— **没有沙箱**，
 *     只在你自己信任的机器/容器里跑（见 `SAFETY.md`）。
 *
 * 用法：
 *   pnpm tsx scripts/bench-swebench.ts --instances verified.jsonl --out predictions.jsonl --limit 1 --yes-spend
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

import { parseSweBenchJsonl, toBenchTask, type SweBenchPrediction } from "../engine/bench/swebench";
import { buildEngine } from "../hosts/cli/assembly";

function arg(name: string, fallback?: string): string | undefined {
  const at = process.argv.indexOf(`--${name}`);
  if (at < 0) return fallback;
  const value = process.argv[at + 1];
  return value && !value.startsWith("--") ? value : fallback;
}
const has = (name: string) => process.argv.includes(`--${name}`);

function sh(cmd: string, args: string[], cwd?: string, encoding: "utf8" | "buffer" = "utf8"): string {
  return execFileSync(cmd, args, {
    cwd,
    encoding: encoding === "buffer" ? undefined : "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
  }) as unknown as string;
}

async function main(): Promise<void> {
  const instancesFile = arg("instances");
  const outFile = arg("out", "predictions.jsonl")!;
  if (!instancesFile) {
    process.stderr.write("要 --instances <verified.jsonl>（下载方式见 bench/swebench/README.md）。\n");
    process.exit(2);
  }
  if (!fs.existsSync(instancesFile)) {
    process.stderr.write(`实例文件不存在：${instancesFile}\n`);
    process.exit(2);
  }
  const provider = arg("provider", "deepseek")!;
  const model = arg("model", "deepseek-chat")!;
  const limit = Math.max(1, Number(arg("limit", "1")) || 1);
  const modelName = arg("model-name", `ding/${provider}/${model}`)!;
  const workRoot = path.resolve(arg("work", path.join(os.tmpdir(), "ding-swebench"))!);
  const keep = has("keep");

  const { instances, badLines } = parseSweBenchJsonl(fs.readFileSync(instancesFile, "utf8"));
  if (badLines.length) {
    process.stderr.write(`⚠️ 有 ${badLines.length} 行读不了（已跳过）：\n`);
    for (const bad of badLines.slice(0, 5)) process.stderr.write(`  第 ${bad.line} 行：${bad.why}\n`);
  }
  if (!instances.length) {
    process.stderr.write("一个可用实例都没有。\n");
    process.exit(2);
  }

  const chosen = instances.slice(0, limit);
  if (!has("yes-spend")) {
    process.stdout.write(
      `计划：跑 ${chosen.length} 条实例（共 ${instances.length} 条），provider=${provider} model=${model}\n` +
        `  这会调用真模型并产生费用；确认后加 --yes-spend。\n` +
        `  输出：${path.resolve(outFile)}\n`,
    );
    process.exit(2);
  }

  fs.mkdirSync(workRoot, { recursive: true });
  fs.mkdirSync(path.dirname(path.resolve(outFile)), { recursive: true });
  const out = fs.createWriteStream(path.resolve(outFile), { flags: "a" });

  /** 整轮用量（跑完打一行总账；**不折算价格** —— 这个中转站的单价我们没有可信来源）。 */
  const totals = { inputTokens: 0, outputTokens: 0, steps: 0 };
  /** 超大补丁（把依赖/产物收进来的那种）不写入预测，单独计数。 */
  let oversize = 0;

  for (let i = 0; i < chosen.length; i += 1) {
    const instance = chosen[i]!;
    const repoDir = path.join(workRoot, instance.instance_id);
    const storeDir = fs.mkdtempSync(path.join(os.tmpdir(), "dh-swe-store-"));
    process.stdout.write(`[${i + 1}/${chosen.length}] ${instance.instance_id} … `);
    try {
      if (!fs.existsSync(repoDir)) {
        sh("git", ["clone", "--quiet", `https://github.com/${instance.repo}.git`, repoDir]);
      }
      sh("git", ["fetch", "--quiet", "origin", instance.base_commit], repoDir);
      sh("git", ["checkout", "--quiet", "--force", instance.base_commit], repoDir);
      /* 每一轮都从干净的 base 开始（上一条的改动不能带进来） */
      sh("git", ["reset", "--hard", "--quiet", instance.base_commit], repoDir);
      sh("git", ["clean", "-fdq"], repoDir);

      const task = toBenchTask(instance);
      const built = await buildEngine([repoDir], storeDir);
      /*
       * 用量：**必须留下**（方案口径"不许编数"）。
       *
       * 这个脚本原来 `onEvent: () => undefined` —— 跑完只知道"生成了补丁"，
       * 花了多少 token 一个字都没有，于是"要不要跑 500 条"只能靠猜。
       * 现在把每步的 usage 累起来，算进这一条与整轮的总账。
       */
      const usage = { inputTokens: 0, outputTokens: 0, steps: 0 };
      try {
        await built.engine.run({
          sessionId: `swe-${instance.instance_id}`,
          provider,
          model,
          system: "",
          messages: [{ role: "user", content: task.turns[0]! }],
          mode: "全部允许",
          useTools: true,
          maxSteps: task.maxSteps ?? 40,
          onEvent: (event) => {
            if (event.type !== "step-finish" && event.type !== "done") return;
            const u = (event as { usage?: { inputTokens?: number; outputTokens?: number } }).usage;
            if (!u) return;
            /* `step-finish` 的 input 是"这一步发出去多少"，要**累加**（每步都重发历史） */
            if (event.type === "step-finish") {
              usage.steps += 1;
              usage.inputTokens += u.inputTokens ?? 0;
              usage.outputTokens += u.outputTokens ?? 0;
            }
          },
        });
      } finally {
        built.close();
      }
      totals.inputTokens += usage.inputTokens;
      totals.outputTokens += usage.outputTokens;
      totals.steps += usage.steps;
      process.stdout.write(
        `（${usage.steps} 步 / 输入 ${usage.inputTokens} tok / 输出 ${usage.outputTokens} tok）`,
      );

      /*
       * 收改动：`git add -A` 把新文件也纳入，`--cached` 出统一 diff。
       * 收完立刻 `reset`：下一条要从干净 base 开始。
       *
       * ⚠️ **必须排除 agent 跑命令留下的杂物**（2026-10-18 实测抓到的真缺陷）。
       *
       * 第一条实测里 flask 那条的补丁有 **87,278 行**：agent 为了能跑测试，
       * 在仓库里 `pip install -t .testlibs …`，而 `git add -A` 把整个依赖目录
       * 一起收进了 patch —— 官方 harness 当然判不过（而且这根本不是它的修复）。
       * 这类目录还有 `__pycache__` / `.pytest_cache` / `.mypy_cache` / `*.egg-info` /
       * `.tox` / `node_modules` / `.venv`。它们**不是补丁的一部分**，必须在 diff 里排除。
       *
       * 排除用 pathspec（`:(exclude)`），而不是先 `git clean` —— clean 会把 agent
       * 真写下的新源文件也删掉（那是修复的一部分）。
       */
      const JUNK_GLOBS = [
        ":(exclude).testlibs/**",
        ":(exclude)**/__pycache__/**",
        ":(exclude).pytest_cache/**",
        ":(exclude)**/.pytest_cache/**",
        ":(exclude).mypy_cache/**",
        ":(exclude).ruff_cache/**",
        ":(exclude)**/*.egg-info/**",
        ":(exclude).tox/**",
        ":(exclude)**/.tox/**",
        ":(exclude)node_modules/**",
        ":(exclude).venv/**",
        ":(exclude)venv/**",
        ":(exclude)**/*.pyc",
      ];
      sh("git", ["add", "-A"], repoDir);
      const patch = sh("git", ["diff", "--cached", "--binary", "--", ".", ...JUNK_GLOBS], repoDir);
      sh("git", ["reset", "--quiet"], repoDir);

      /*
       * 补丁体积守卫：**超大的补丁不写进预测**（写了也是必然判不过，还污染成绩口径）。
       * 3000 行是"正常修复 + 几个测试"的天花板；超过它多半是把依赖/产物收进来了。
       */
      const MAX_PATCH_LINES = 3000;
      const patchLines = patch ? patch.split("\n").length : 0;
      if (patchLines > MAX_PATCH_LINES) {
        process.stdout.write(
          `⚠️ 补丁 ${patchLines} 行，超过 ${MAX_PATCH_LINES} 行上限 —— 视为"把非源码改动收进来了"，**不写入预测**（这一条按失败计）\n`,
        );
        oversize += 1;
      } else {
        const line: SweBenchPrediction = { instance_id: instance.instance_id, model_name_or_path: modelName, model_patch: patch };
        out.write(JSON.stringify(line) + "\n");
        process.stdout.write(patch.trim() ? `完成（补丁 ${patchLines} 行）\n` : "完成（无改动）\n");
      }
    } catch (error) {
      process.stdout.write(`失败：${String((error as Error)?.message ?? error).split("\n")[0]}\n`);
    } finally {
      /*
       * ⚠️ 清理**必须尽力而为**（2026-10-18，50 条那轮实测）。
       *
       * Windows 上刚跑完的仓库目录里可能有还开着的文件句柄（agent 起的子进程刚退、
       * 索引器还在扫），`rmSync` 会抛 EPERM —— 而那一下**把整轮 50 条带走了**
       * （跑到第 9 条就整体退出，前面 8 条白跑）。清理失败只该留个目录，不该中断测量。
       * 多试两次、再不行就留着（下一轮同 id 会先 `git reset --hard` 复用）。
       */
      for (const dir of [storeDir, ...(keep ? [] : [repoDir])]) {
        for (let attempt = 0; attempt < 3; attempt += 1) {
          try {
            fs.rmSync(dir, { recursive: true, force: true });
            break;
          } catch {
            try {
              await new Promise((r) => setTimeout(r, 400));
            } catch {
              /* 忽略 */
            }
          }
        }
      }
    }
  }

  await new Promise<void>((resolve) => out.end(resolve));
  const per = chosen.length;
  process.stdout.write(
    `\n用量：${per} 条 / ${totals.steps} 步 / 输入 ${totals.inputTokens} tok / 输出 ${totals.outputTokens} tok` +
      `（每条平均 输入 ${per ? Math.round(totals.inputTokens / per) : 0} tok / 输出 ${per ? Math.round(totals.outputTokens / per) : 0} tok）\n` +
      (oversize ? `⚠️ ${oversize} 条因补丁超大（疑似把依赖/产物收进来）未写入预测 —— 它们按失败计，别混进通过率。\n` : "") +
      `⚠️ **不折算成金额**：这个通道的单价没有可信来源，token 数是真的、钱要你自己按账单核。\n` +
      `预测已写入 ${path.resolve(outFile)}\n` +
      `判分请用官方 harness（见 bench/swebench/README.md）。**本脚本不产生成绩数字。**\n`,
  );
}

void main().catch((error: unknown) => {
  process.stderr.write(`出错了：${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
  process.exit(1);
});
