/**
 * `ding init` / `ding doctor` —— 首次配置向导与一键自检（Phase 11.3 / 11.4）。
 *
 * 从 `ding.ts` 拆出来的（结构守卫 C6-5）。
 */
import { createInterface } from "node:readline";
import path from "node:path";

import { credentialsPath } from "../../engine/runtime/credentials";
import { firstAvailableProvider } from "../../engine/runtime/providers";
import { configPaths, readConfig } from "./config";
import { formatDoctor, runDoctor } from "./doctor";
import { runWizard, type WizardIo } from "./wizard";
import type { Parsed } from "./args";
/* ────────────────────── init（Phase 11.3） ────────────────────── */

/**
 * 问一句话并读到一行，**不回显输入**（2026-10-16，审计 P199）。
 *
 * ## 为什么必须有它
 *
 * `WizardIo.ask` 的签名里一直有 `opts.secret`（`wizard.ts` 用
 * `io.ask("粘贴 key…", { secret: true })` 调它），而这份实现**从来没有读过它** ——
 * 用的就是普通 `rl.question`，于是**向导让人贴的 API key 明文打在屏幕上**
 * （截屏、`script` 录像、站在旁边的同事都看得见），而向导的文案说的是"粘贴 key"。
 * 声明了却没人实现的选项，与"承诺了却没做"是同一件事。
 *
 * ## 做法与风险
 *
 * readline 没有遮蔽能力，所以这里：**先把它关掉**（否则两个消费者抢同一路
 * `data`，readline 也会把字符原样回显出来 —— 那时遮蔽就是假的），
 * 再用 raw mode 自己逐字符收，每个可见字符打一个 `*`。
 *
 * ⚠️ 结束一定要 `rl` 之外的状态还原（raw mode）与**重建 readline**，
 * 且任何一步出错都退回"普通问法 + 一句提醒"而不是把向导打死 ——
 * 一个把人卡在首启配置上的 bug 比回显严重（这也是本仓 `wizard.ts` 那条教训）。
 */
export async function askMasked(
  rlRef: { current: ReturnType<typeof createInterface> },
  question: string,
  plainFallback: () => Promise<string>,
): Promise<string> {
  const stdin = process.stdin;
  if (!stdin.isTTY) return plainFallback();
  try {
    rlRef.current.close();
    return await new Promise<string>((resolve, reject) => {
      const wasRaw = stdin.isRaw === true;
      let buf = "";
      process.stdout.write(question);
      const done = (value: string, failed?: unknown) => {
        stdin.removeListener("data", onData);
        try {
          if (stdin.isTTY) stdin.setRawMode(wasRaw);
        } catch {
          /* 还原失败不该让人看不到结果 */
        }
        stdin.pause();
        if (failed) reject(failed);
        else resolve(value);
      };
      const onData = (chunk: Buffer) => {
        for (const ch of chunk.toString("utf8")) {
          if (ch === "\r" || ch === "\n") {
            process.stdout.write("\n");
            done(buf);
            return;
          }
          if (ch === "\u0003") {
            /* Ctrl+C：与普通问法一致的行为（放弃这一问） */
            process.stdout.write("\n");
            done("");
            return;
          }
          if (ch === "\u007f" || ch === "\b") {
            if (buf) {
              buf = buf.slice(0, -1);
              process.stdout.write("\b \b");
            }
            continue;
          }
          if (ch < " ") continue; // 忽略其它控制字符（方向键等）
          buf += ch;
          process.stdout.write("*");
        }
      };
      try {
        stdin.setRawMode(true);
      } catch (e) {
        done("", e);
        return;
      }
      stdin.resume();
      stdin.on("data", onData);
    });
  } catch {
    /* 遮蔽这条路出了任何问题：用户更需要"能配下去"，所以退回普通问法并说清 */
    process.stderr.write("（⚠️ 这个终端不支持遮蔽输入，接下来这一问会明文显示）\n");
    return plainFallback();
  } finally {
    /* 无论成败都要把 readline 还回去（后面还有问题要问） */
    rlRef.current = createInterface({ input: process.stdin, output: process.stdout });
  }
}

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

  const rlRef = { current: createInterface({ input: process.stdin, output: process.stdout }) };
  const plainAsk = (q: string, opts?: { default?: string }) =>
    new Promise<string>((resolve) => {
      const suffix = opts?.default ? ` [${opts.default}]` : "";
      rlRef.current.question(`${q}${suffix} `, (answer) => resolve(answer.trim() || opts?.default || ""));
    });
  const io: WizardIo = {
    ask: (q, opts) =>
      opts?.secret
        ? askMasked(rlRef, `${q} `, () => plainAsk(q, opts))
        : plainAsk(q, opts),
    say: (line) => process.stdout.write(line + "\n"),
  };
  try {
    /*
     * ⚠️ `hasUsableProvider` 现在**传的是真值**（2026-10-16，审计 P221）。
     *
     * 原来硬塞 `false`：一个"看起来会影响分支"的入参，实际传什么都一样。
     * ⚠️ 但要如实说：`hosts/cli/wizard.ts` 的 `runWizard` **目前仍然不读它**
     * （只用了 `dataDir`）—— 那半边不属这份工单的文件范围。
     * 这里先把"说假话"这一半去掉：调用方给的是本机真实情况。
     */
    const result = await runWizard(io, { dataDir: dataDir, hasUsableProvider: firstAvailableProvider() !== undefined });
    if (result.skipped) {
      process.stderr.write(`向导中断：${result.skipped}\n`);
      return 3;
    }
    return 0;
  } finally {
    rlRef.current.close();
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

