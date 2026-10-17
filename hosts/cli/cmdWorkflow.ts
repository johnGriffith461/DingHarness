/**
 * `ding workflow` —— 多 agent 工作流（V6-2l）。
 *
 * ```
 * ding workflow validate <定义.json>
 * ding workflow run <定义.json> [--provider p --model m] [--out <运行.json>]
 * ding workflow run --resume <运行.json> [--retry-failed]
 * ding workflow list
 * ding workflow show <运行 id|文件>
 * ```
 *
 * 定义长这样（`steps[].dependsOn` 决定泳道）：
 * ```json
 * {
 *   "name": "周报流水线",
 *   "steps": [
 *     { "id": "research", "agent": "researcher", "task": "收集本周数据" },
 *     { "id": "write", "agent": "writer", "task": "写成周报", "dependsOn": ["research"] }
 *   ]
 * }
 * ```
 *
 * 中断（Ctrl+C）只标 `paused` 并落检查点；`--resume` 从没做完的层继续。
 */
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

import { resolveSecret } from "../../engine/runtime/credentials";
import { allProviders, firstAvailableProvider } from "../../engine/runtime/providers";
import { runWorkflow } from "../../engine/workflow/run";
import { parseWorkflowDsl } from "../../engine/workflow/dsl";
import {
  STATUS_LABEL,
  newRun,
  validateWorkflow,
  type WorkflowRun,
  type WorkflowSpec,
} from "../../engine/workflow/types";
import { buildEngine } from "./assembly";
import { flag, type Parsed } from "./args";
import { readConfig } from "./config";

function runsDir(dataDir: string): string {
  return path.join(dataDir, "workflows", "runs");
}

function writeRun(file: string, run: WorkflowRun): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(run, null, 2)}\n`, "utf8");
  renameSync(tmp, file);
}

function readRun(file: string): WorkflowRun | null {
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as WorkflowRun;
    return raw && typeof raw === "object" && Array.isArray(raw.steps) ? raw : null;
  } catch {
    return null;
  }
}

/**
 * 读一份工作流定义：`.json` 走 JSON，其它（或内容不是 JSON）走 **DSL**（L03）。
 *
 * @param file 文件路径
 * @returns 定义，或者一句说清的问题
 */
function readSpecFile(file: string): { spec: WorkflowSpec } | { error: string } {
  const text = readFileSync(path.resolve(file), "utf8");
  const trimmed = text.trimStart();
  if (file.toLowerCase().endsWith(".json") || trimmed.startsWith("{")) {
    try {
      return { spec: JSON.parse(text) as WorkflowSpec };
    } catch (error) {
      return { error: `JSON 解析失败：${String((error as Error)?.message ?? error)}` };
    }
  }
  const parsed = parseWorkflowDsl(text, { fallbackName: path.basename(file, path.extname(file)) });
  if (!parsed.ok) {
    const lines = parsed.problems.map((problem) => `  · ${problem}`).join(String.fromCharCode(10));
    return { error: `DSL 有问题：` + String.fromCharCode(10) + lines };
  }
  return { spec: parsed.spec };
}

function resolveTarget(p: Parsed, dataDir: string): { provider: string; model?: string } | { error: string } {
  const config = readConfig(dataDir).config;
  const provider = flag(p, "provider") ?? config.provider ?? firstAvailableProvider(resolveSecret)?.id;
  if (!provider) return { error: "没有可用的 provider：先 ding init 配一个，或用 --provider 指定" };
  const known = allProviders().find((x) => x.id === provider);
  if (!known) return { error: `不认识的 provider：${provider}` };
  const model = flag(p, "model") ?? config.model ?? known.models[0];
  return { provider, ...(model ? { model } : {}) };
}

function printRun(run: WorkflowRun): void {
  process.stdout.write(
    `\n${run.name}（${run.id}）${run.status}` +
      (run.error ? `　${run.error}` : "") +
      `\n`,
  );
  for (const step of run.steps) {
    const at = step.finishedAt ? `　${Math.round((step.finishedAt - (step.startedAt ?? step.finishedAt)) / 1000)}s` : "";
    process.stdout.write(
      `  ${STATUS_LABEL[step.status]}　${step.id}　[${step.agent}]${at}` +
        (step.dependsOn.length ? `　依赖 ${step.dependsOn.join("/")}` : "") +
        (step.error ? `\n      ${step.error}` : "") +
        "\n",
    );
  }
}

/** 在目录里按运行 id 找文件。 */
function findRunFile(dataDir: string, idOrFile: string): string | null {
  if (existsSync(idOrFile)) return path.resolve(idOrFile);
  const dir = runsDir(dataDir);
  if (!existsSync(dir)) return null;
  const hit = readdirSync(dir).find((name) => name === `${idOrFile}.json` || name.startsWith(`${idOrFile}-`));
  return hit ? path.join(dir, hit) : null;
}

export async function cmdWorkflow(p: Parsed, dataDir: string): Promise<number> {
  const sub = p.args[0] ?? "list";

  if (sub === "validate") {
    const file = p.args[1];
    if (!file) {
      process.stderr.write("用法：ding workflow validate <定义.json>\n");
      return 2;
    }
    try {
      const loaded = readSpecFile(file);
      if ("error" in loaded) {
        process.stderr.write(`${loaded.error}
`);
        return 1;
      }
      const spec = loaded.spec;
      const errors = validateWorkflow(spec);
      if (errors.length) {
        process.stderr.write(`✗ 定义不合法：\n${errors.map((e) => `  · ${e}`).join("\n")}\n`);
        return 1;
      }
      process.stdout.write(`✓ 合法：${spec.name}，${spec.steps.length} 个步骤\n`);
      return 0;
    } catch (error) {
      process.stderr.write(`读不了定义：${String((error as Error)?.message ?? error)}\n`);
      return 1;
    }
  }

  if (sub === "run") {
    const resumeFile = flag(p, "resume");
    const specArg = p.args[1];
    let run: WorkflowRun;
    let outFile: string | undefined;

    if (resumeFile) {
      const file = findRunFile(dataDir, resumeFile);
      if (!file) {
        process.stderr.write(`找不到运行：${resumeFile}\n`);
        return 2;
      }
      const loaded = readRun(file);
      if (!loaded) {
        process.stderr.write(`运行文件读不动：${file}\n`);
        return 1;
      }
      run = loaded;
      run.status = "running";
      outFile = file;
      process.stdout.write(`↻ 从检查点续跑：${run.name}（${run.id}）\n`);
    } else {
      if (!specArg) {
        process.stderr.write("用法：ding workflow run <定义.json> [--out <运行.json>] | --resume <运行.json>\n");
        return 2;
      }
      let spec: WorkflowSpec;
      try {
        spec = JSON.parse(readFileSync(path.resolve(specArg), "utf8")) as WorkflowSpec;
      } catch (error) {
        process.stderr.write(`读不了定义：${String((error as Error)?.message ?? error)}\n`);
        return 1;
      }
      const errors = validateWorkflow(spec);
      if (errors.length) {
        process.stderr.write(`✗ 定义不合法：\n${errors.map((e) => `  · ${e}`).join("\n")}\n`);
        return 1;
      }
      const id = `wf-${Date.now().toString(36)}-${randomUUID().slice(0, 4)}`;
      run = newRun(spec, { id, specFile: path.resolve(specArg) });
      outFile = flag(p, "out") ?? path.join(runsDir(dataDir), `${id}.json`);
      writeRun(outFile, run);
    }

    const target = resolveTarget(p, dataDir);
    if ("error" in target) {
      process.stderr.write(`${target.error}\n`);
      return 2;
    }

    const controller = new AbortController();
    let interrupted = false;
    const onSigint = () => {
      if (interrupted) {
        process.stderr.write("\n再按一次 Ctrl+C 强制退出（检查点已落盘）。\n");
        process.exit(130);
      }
      interrupted = true;
      process.stderr.write("\n收到 Ctrl+C：正在把这一层收尾并落检查点…（再按一次强制退出）\n");
      controller.abort();
    };
    process.on("SIGINT", onSigint);

    const built = await buildEngine([process.cwd()], dataDir);
    let lastPrinted = 0;
    try {
      const final = await runWorkflow(run, {
        provider: target.provider,
        ...(target.model ? { model: target.model } : {}),
        callerMode: "按需确认",
        makeTools: built.makeTools,
        signal: controller.signal,
        retryFailed: p.flags.has("retry-failed"),
        onCheckpoint: (state) => {
          if (outFile) writeRun(outFile, state);
        },
        onUpdate: (state) => {
          /* 每完成一层打一行（不刷屏） */
          const done = state.steps.filter((s) => s.status === "done" || s.status === "failed" || s.status === "skipped").length;
          if (done !== lastPrinted) {
            lastPrinted = done;
            process.stdout.write(`  … ${done}/${state.steps.length} 步收尾\n`);
          }
        },
      });
      printRun(final);
      if (final.status === "paused") {
        process.stdout.write(
          `\n已暂停。续跑：ding workflow run --resume "${outFile}"` + (p.flags.has("retry-failed") ? " --retry-failed" : "") + "\n",
        );
        return 0;
      }
      if (outFile) process.stdout.write(`\n运行记录：${outFile}\n`);
      return final.status === "done" ? 0 : 1;
    } finally {
      process.off("SIGINT", onSigint);
      built.close();
    }
  }

  if (sub === "list") {
    const dir = runsDir(dataDir);
    const files = existsSync(dir) ? readdirSync(dir).filter((name) => name.endsWith(".json")) : [];
    if (!files.length) {
      process.stdout.write(`还没有工作流运行（目录：${dir}）\n`);
      return 0;
    }
    for (const name of files.sort().reverse()) {
      const run = readRun(path.join(dir, name));
      if (!run) continue;
      const done = run.steps.filter((s) => s.status === "done").length;
      process.stdout.write(
        `${run.id}　${run.name}　[${run.status}]　${done}/${run.steps.length} 步　${new Date(run.updatedAt).toISOString().slice(0, 16).replace("T", " ")}\n`,
      );
    }
    return 0;
  }

  if (sub === "show") {
    const target = p.args[1];
    if (!target) {
      process.stderr.write("用法：ding workflow show <运行 id|文件>\n");
      return 2;
    }
    const file = findRunFile(dataDir, target);
    if (!file) {
      process.stderr.write(`找不到运行：${target}\n`);
      return 2;
    }
    const run = readRun(file);
    if (!run) {
      process.stderr.write(`运行文件读不动：${file}\n`);
      return 1;
    }
    printRun(run);
    return run.status === "failed" ? 1 : 0;
  }

  process.stderr.write("用法：ding workflow run|validate|list|show …\n");
  return 2;
}
