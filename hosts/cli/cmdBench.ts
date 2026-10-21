/**
 * `ding bench` —— 公开基准（V6-1a）。
 *
 * 两个子命令：
 *   · `ding bench list [suite]` —— 列任务（id/类别/split/一句说明）；
 *   · `ding bench run [suite]`  —— 跑一批，出报告（`--json` 给机器，`--out` 落文件）。
 *
 * ⚠️ 与 `ding eval` 分开：eval 判**过程**（内部夹具），bench 判**任务结果**。
 * 两者混成一条通过率，等于拿"自己出的过程题"当"能干活"的证据。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describeFailureSummary } from "../../engine/eval/failClassifier";
import { benchRoot, loadSuite } from "../../engine/bench/load";
import { runBenchSuite } from "../../engine/bench/run";
import { buildEngine as buildEngineIn } from "./assembly";
import { flag, flagAll, parseIntFlagValue, type Parsed } from "./args";

/** 往上找 `bench/suites` 标记（与 `engine/bench/load.ts` 同一口径）。 */
function root(): string {
  const starts = [process.cwd(), ...(typeof __dirname === "string" ? [__dirname] : [])];
  for (const start of starts) {
    try {
      return benchRoot(start);
    } catch {
      /* 换下一个起点 */
    }
  }
  return process.cwd();
}

/** `ding bench list [suite]`。 */
function list(p: Parsed): number {
  const suite = p.args[0] ?? "harness";
  let loaded;
  try {
    loaded = loadSuite(suite, root());
  } catch (error) {
    process.stderr.write(`${String((error as Error)?.message ?? error)}\n`);
    return 2;
  }
  process.stdout.write(`${loaded.suite.name}${loaded.suite.description ? ` —— ${loaded.suite.description}` : ""}\n`);
  for (const task of loaded.tasks) {
    process.stdout.write(`  ${task.id}  [${task.split}/${task.category}]  ${task.title}\n`);
    if (task.description) process.stdout.write(`      ${task.description}\n`);
  }
  process.stdout.write(`\n共 ${loaded.tasks.length} 条（train ${loaded.tasks.filter((t) => t.split === "train").length} / test ${loaded.tasks.filter((t) => t.split === "test").length}）\n`);
  return 0;
}

/** `ding bench run [suite]`。 */
export async function cmdBench(p: Parsed): Promise<number> {
  /*
   * eval/bench 走**假 provider**（`strata`）：它已从出厂表移除，只在
   * `DING_ACCEPT_PROVIDERS=1` 时注册 —— 这两条命令就是"验收/评测"，自己打开。
   */
  process.env.DING_ACCEPT_PROVIDERS ??= "1";

  const explicit = p.args[0] === "list" || p.args[0] === "run";
  const sub = p.args[0] === "list" ? "list" : "run";
  /* `ding bench run [suite]` 与 `ding bench [suite]` 两种写法都认 */
  const suiteArg = (explicit ? p.args[1] : p.args[0]) ?? flag(p, "suite") ?? "harness";
  if (sub === "list") return list({ ...p, args: [suiteArg] });

  let loaded;
  try {
    loaded = loadSuite(suiteArg, root());
  } catch (error) {
    process.stderr.write(`${String((error as Error)?.message ?? error)}\n`);
    return 2;
  }

  const taskIds = new Set(flagAll(p, "task"));
  const split = flag(p, "split");
  if (split && split !== "train" && split !== "test") {
    process.stderr.write(`--split 只能是 train 或 test（给了「${split}」）\n`);
    return 2;
  }
  const repeat = parseIntFlagValue(flag(p, "repeat"), "repeat", { min: 1, max: 20, fallback: 1 });
  if (!repeat.ok) {
    process.stderr.write(`${repeat.message}\n`);
    return 2;
  }

  const tasks = loaded.tasks.filter((t) => (!taskIds.size || taskIds.has(t.id)) && (!split || t.split === split));
  if (!tasks.length) {
    process.stderr.write(`过滤后没有任务（suite=${loaded.suite.name}，task=${[...taskIds].join(",") || "全部"}，split=${split ?? "全部"}）\n`);
    return 2;
  }

  const docker = p.flags.has("docker");
  const report = await runBenchSuite(
    tasks,
    {
      makeEngine: async (workDir) => {
        const storeDir = fs.mkdtempSync(path.join(os.tmpdir(), "dh-bench-store-"));
        const built = await buildEngineIn([workDir], storeDir);
        return {
          engine: built.engine,
          close: () => {
            built.close();
            fs.rmSync(storeDir, { recursive: true, force: true });
          },
        };
      },
      docker,
    },
    { suite: loaded.suite.name, repeat: repeat.value, root: loaded.file },
    (r, i, total) => {
      if (p.flags.has("json")) return;
      const mark = r.skipped ? "⏭️" : r.ok ? "✓" : "✗";
      const sample = repeat.value > 1 ? `（${r.passedRuns}/${r.runs}${r.flaky ? "，不稳定" : ""}）` : "";
      process.stdout.write(`${mark} [${i}/${total}] ${r.id}  ${r.title}${sample}\n`);
      if (r.skipped) process.stdout.write(`     跳过：${r.skipped}\n`);
      for (const f of r.failures) process.stdout.write(`     ${f.what}：${f.detail}\n`);
    },
  );

  if (p.flags.has("json")) {
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  } else {
    process.stdout.write(
      `\n${report.suite}：${report.total} 条（通过 ${report.passed}，失败 ${report.failed}` +
        (report.skipped ? `，跳过 ${report.skipped}` : "") +
        `），通过率 ${report.rate}%\n`,
    );
    if (report.samples > 1) {
      process.stdout.write(`  采样 ${report.samples} 次：pass@${report.samples} ${report.passAtKRate}%，pass^${report.samples} ${report.passAllRate}%，不稳定 ${report.flaky} 条\n`);
    }
    for (const [category, slot] of Object.entries(report.byCategory)) {
      process.stdout.write(`  ${category}：${slot.passed}/${slot.total}\n`);
    }
    const failures = describeFailureSummary(report.byFailure);
    if (failures) process.stdout.write(`  失败分类：${failures}\n`);
    process.stdout.write(`  环境：Node ${report.environment.node} / ${report.environment.platform} / Docker ${report.environment.docker ? "有" : "无"}\n`);
  }

  const out = flag(p, "out");
  if (out) {
    fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
    fs.writeFileSync(path.resolve(out), JSON.stringify(report, null, 2) + "\n", "utf8");
    if (!p.flags.has("json")) process.stdout.write(`报告已写入：${path.resolve(out)}\n`);
  }

  /*
   * 退出码：有失败 → 1；**只有跳过**（环境不满足）→ 0，但报告里如实列出来。
   * 跳过不该让 CI 红（那会把"这台机器缺 Docker"伪装成产品坏了），
   * 也不该被当成通过（`total` 里本来就不算它）。
   */
  return report.failed > 0 ? 1 : 0;
}
