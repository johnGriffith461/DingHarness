import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * C2-3 连线守卫：**一份循环**的三处接线不许被拆开。
 *
 * ## 为什么用"读源码"这种笨办法
 *
 * C2-3 把主循环收成一份，两条路（`ai:chat` 与子智能体）都用它。
 * ⚠️ Phase 1 内迁之后它住在内核 `engine/runtime/loop.ts`（曾名 `electron/ipc/runTurn.ts`）——
 * 下面的路径跟着改；不改的话这守卫扫的是**不存在的文件**，它会红，但也提醒了"守卫要跟着搬"。
 * 它带来的收益里有三条**没法用单测证明**（都在主进程、都要真跑模型与真中止）：
 *
 * 1. 父级的中止信号一路传到子智能体（用户点停，子智能体也得停）；
 * 2. 子智能体走同一份循环 → 自动获得 `tool-error` 分支与 provider 健康标记；
 * 3. 步数上限是**参数**（父 4 / 子 6），不是两条代码路径。
 *
 * 端到端验证第 1 条要"发一条长回答 + 中途点停 + 计时 + 看子智能体是否还在跑"——
 * 贵且偶发。所以这里退一步：**钉住接线本身**（谁把信号传给谁），
 * 并在 `docs/HANDOFF.md` 里如实写"端到端未验"。
 * ⚠️（该依据未入库、本机也找不到 —— 决策链断在这里，无法复核；以本文件里的断言与实现为准）
 * 这样至少"有人顺手删掉 signal 那一行"会被立刻挡住。
 *
 * ⚠️ 判据是**接线**不是**存在**：只断言 `signal` 真的从 controller 流到工具环境、
 * 从 env 流到 `runSubagent`、从 `runSubagent` 流到 `runTurn`。
 *
 * ⚠️ Phase 4.1 之后这条线**穿过内核**：`ai:chat` 把信号交给 `engine.run`，
 * 由引擎放进 `ExecutorContext`。判据跟着改，但**要断言的那件事没变** ——
 * 信号必须一路到得了工具（否则"点了停止、子智能体还在跑"）。所以下面同时读宿主与内核。
 */

const ROOT = path.resolve(__dirname, "..");
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");

describe("C2-3 连线守卫：一份循环 + 中止信号穿三层", () => {
  it("① `ai:chat` 把 controller 的信号交给引擎（引擎再放进工具环境）", () => {
    const host = read("electron/ipc/ai.ts");
    expect(host, "调用引擎时没有把中止信号传下去").toContain("abortSignal: controller.signal");
    const kernel = read("engine/index.ts");
    expect(kernel, "引擎没有把 abortSignal 放进执行上下文 → 子智能体拿不到中止信号").toContain(
      "...(request.abortSignal ? { signal: request.abortSignal } : {}),",
    );
  });

  it("② 工具执行把信号交给子智能体", () => {
    const src = read("electron/ipc/tools.ts");
    expect(src, "ToolEnv 上没有 signal 字段").toContain("signal?: AbortSignal;");
    expect(src, "spawn_agent 没把 env.signal 传给 runSubagent").toContain("...(env.signal ? { signal: env.signal } : {})");
  });

  it("③ 子智能体用的是同一份循环，并把信号传下去", () => {
    const src = read("engine/runtime/subagent.ts");
    expect(src, "子智能体没有走 runTurn（那就是又长出一份循环）").toContain("runTurn(");
    expect(src, "runSubagent 没把 signal 传给 runTurn").toContain("...(input.signal ? { abortSignal: input.signal } : {})");
    expect(src, "子智能体又自己写了一份 streamText（第二份循环）").not.toContain("streamText(");
  });

  it("⑤ 桌面宿主**经引擎**跑（自己调 runTurn = 绕过引擎的落盘与账本）", () => {
    const host = read("electron/ipc/ai.ts");
    expect(host, "ai.ts 没有建引擎").toContain("createEngine({");
    expect(host, "ai.ts 没有调用 engine.run").toContain("await engine.run({");
    // 直接调 runTurn 会让这一轮**没有日志**（引擎才写日志）——表面上看不出，重启后才发现历史缺了一段
    expect(host, "ai.ts 绕过引擎直接调了 runTurn").not.toMatch(/runTurn\s*\(/);
    // 事件的落盘由引擎负责：宿主只把事件发上屏，不再自己写一份日志
    expect(host, "ai.ts 又在自己写事件日志（第二份真相）").not.toContain("sessionLog?.log(");
  });

  it("④ 步数上限是参数（父 4 / 子 6），两条路共用同一份循环", () => {
    const host = read("electron/ipc/ai.ts");
    const kernel = read("engine/index.ts");
    const sub = read("engine/runtime/subagent.ts");
    expect(kernel, "父级的步数上限应当是 4（沿用原值，不许顺手统一）").toContain("maxSteps: request.maxSteps ?? 4");
    expect(sub, "子智能体的步数上限应当是 6（沿用原值）").toContain("maxSteps: input.maxSteps ?? 6");
    // 两份循环的痕迹：宿主不该再直接 import streamText
    expect(host, "ai.ts 又自己 import 了 streamText（第二份循环）").not.toContain("streamText");
  });

  it("⚠️ **全仓只有一份主循环**（G32：原来那句「两份源码拼起来 toContain(runTurn)」恒真）", () => {
    /*
     * ⚠️ 2026-10-16（审计 G32）：原来这里是把两份源码拼起来 `toContain("runTurn")` ——
     * 两个文件里都必然出现这个词，**恒真**，等于没断。真正的不变量是：
     *   · `runTurn` 的实现**只有一处**（多出一处 = 又长了一份循环）；
     *   · 真正的 SDK 调用（`streamText(`）也**只在那一个文件里**。
     * 这两条会红的方式很具体：谁在别处 `export async function runTurn` 或自己调 streamText。
     */
    const roots = ["src", "shared", "engine", "hosts", "electron"];
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
        const rel = `${dir}/${entry.name}`;
        if (entry.isDirectory()) {
          if (entry.name === "node_modules") continue;
          walk(rel);
        } else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) files.push(rel);
      }
    };
    for (const r of roots) walk(r);

    const definesRunTurn: string[] = [];
    const callsStreamText: string[] = [];
    for (const rel of files) {
      /* ⚠️ 先去掉注释（这个坑本项目踩过多次：注释里提到 streamText( 会被当成真调用） */
      const text = read(rel)
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^\s*\/\/.*$/gm, "");
      if (/export\s+async\s+function\s+runTurn\s*\(/.test(text)) definesRunTurn.push(rel);
      if (/\bstreamText\s*\(/.test(text)) callsStreamText.push(rel);
    }
    expect(definesRunTurn, "主循环出现了第二份实现（runTurn 只该有一处定义）").toEqual(["engine/runtime/loop.ts"]);
    expect(callsStreamText, "SDK 调用出现在主循环之外（第二份循环）").toEqual(["engine/runtime/loop.ts"]);
  });

  it("⚠️ 边界如实记：桌面那条路**不在这条守卫的射程里**（要 Electron 才能真跑）", () => {
    /*
     * 这条守卫全是"读源码"型的：它证明的是**接线写得对**，不是"真跑一轮时信号真到得了"。
     * 端到端那半在 `engine/eval/hostParity.test.ts`（直连 vs ACP 两条路）与桌面验收脚本里，
     * 桌面主进程本身在 vitest 里 import 不了 —— 这一点写在这里，免得有人把它当成已验。
     *
     * ⚠️ 2026-10-16（审计 D9）：这一条原来只有一句 `expect(true).toBe(true)` ——
     * 一段**没有任何判定**的"测试"（注释却说得像验过）。注释里那句
     * 「端到端那半在 hostParity.test.ts」是**可查的**，所以把它变成真断言：
     * 谁把那份端到端验删了/掏空了，这里就红，而不是留下一句没人管的话。
     * （边界本身仍然成立：**接线对 ≠ 真跑到**，这半件事本文件确实证明不了。）
     */
    const e2e = path.join(ROOT, "engine/eval/hostParity.test.ts");
    expect(existsSync(e2e), "注释说端到端那半在 engine/eval/hostParity.test.ts —— 它不在了").toBe(true);
    expect(readFileSync(e2e, "utf8").length, "那份端到端验被掏空了").toBeGreaterThan(500);
  });
});
