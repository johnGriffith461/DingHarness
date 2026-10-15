/**
 * `ding init` / `ding doctor` —— 首次配置向导与一键自检（Phase 11.3 / 11.4）。
 *
 * 从 `ding.ts` 拆出来的（结构守卫 C6-5）。
 */
import { createInterface } from "node:readline";
import path from "node:path";

import { credentialsPath } from "../../engine/runtime/credentials";
import { configPaths, readConfig } from "./config";
import { formatDoctor, runDoctor } from "./doctor";
import { runWizard, type WizardIo } from "./wizard";
import type { Parsed } from "./args";
/* ────────────────────── init（Phase 11.3） ────────────────────── */

/**
 * `ding init` —— 首次配置向导（也可以随时重跑，改默认值）。
 *
 * 向导逻辑在 `./wizard.ts`（纯逻辑 + 注入 IO，所以"≤5 分钟上手"那条能被自动重放，
 * 而不是靠某次手工演示）。这里只负责把**终端**接上去。
 */
export async function cmdInit(p: Parsed, dataDir: string): Promise<number> {
  if (p.flags.has("json") || !process.stdin.isTTY) {
    /*
     * 非交互环境（管道/CI）：**不提问**。报清楚"该怎么配"就够了 ——
     * 一个在 CI 里等输入的向导会把流水线卡死。
     */
    process.stdout.write(
      [
        "ding init 需要一个交互式终端（现在不是）。",
        "",
        "非交互环境里这样配：",
        `  · 把 key 写进 ${credentialsPath()}，例如 \`DEEPSEEK_API_KEY: sk-…\``,
        "  · 或者设环境变量：DEEPSEEK_API_KEY / ANTHROPIC_API_KEY / OPENAI_API_KEY …",
        `  · 默认 provider / 模型 / 档位 / 目录写进 ${path.join(dataDir, "config.json")}`,
        "",
        "配完跑 `ding doctor` 确认。",
      ].join("\n") + "\n");
    return 2;
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const io: WizardIo = {
    ask: (q, opts) =>
      new Promise((resolve) => {
        const suffix = opts?.default ? ` [${opts.default}]` : "";
        rl.question(`${q}${suffix} `, (answer) => resolve(answer.trim() || opts?.default || ""));
      }),
    say: (line) => process.stdout.write(line + "\n"),
  };
  try {
    const result = await runWizard(io, { dataDir: dataDir, hasUsableProvider: false });
    if (result.skipped) {
      process.stderr.write(`向导中断：${result.skipped}\n`);
      return 3;
    }
    return 0;
  } finally {
    rl.close();
  }
}

/* ────────────────────── doctor（Phase 11.4） ────────────────────── */

/**
 * `ding doctor [--json]` —— 一键自检。
 *
 * 方案 11.4 的验收：**"失败项 100% 带 actionable 指引"**。
 * 那条要求落在 `hosts/cli/doctor.ts` 的类型里（`Check.next` 是必填）——
 * 也就是说，加一项检查而忘了写下一步，**编译就过不去**。
 *
 * @param p 解析后的参数
 * @returns 退出码（有待处理项 = 1，这样脚本里能 `ding doctor || 处理`）
 */
export function cmdDoctor(p: Parsed, dataDir: string): number {
  const dir = dataDir;
  const paths = configPaths(dir);
  const read = readConfig(dir);
  const checks = runDoctor({
    dataDir: dir,
    configPath: paths.primary,
    rawConfig: read.config,
    runtime: [`${process.platform} ${process.arch}`, `Node ${process.version}`].join(" / "),
    bunBinary: typeof (process.versions as { bun?: string }).bun === "string",
  });
  process.stdout.write(formatDoctor(checks, { json: p.flags.has("json") }) + "\n");
  return checks.some((c) => !c.ok) ? 1 : 0;
}

