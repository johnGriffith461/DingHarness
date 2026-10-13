import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * C2-3 连线守卫：**一份循环**的三处接线不许被拆开。
 *
 * ## 为什么用"读源码"这种笨办法
 *
 * C2-3 把主循环收成 `electron/ipc/runTurn.ts`，两条路（`ai:chat` 与子智能体）都用它。
 * 它带来的收益里有三条**没法用单测证明**（都在主进程、都要真跑模型与真中止）：
 *
 * 1. 父级的中止信号一路传到子智能体（用户点停，子智能体也得停）；
 * 2. 子智能体走同一份循环 → 自动获得 `tool-error` 分支与 provider 健康标记；
 * 3. 步数上限是**参数**（父 4 / 子 6），不是两条代码路径。
 *
 * 端到端验证第 1 条要"发一条长回答 + 中途点停 + 计时 + 看子智能体是否还在跑"——
 * 贵且偶发。所以这里退一步：**钉住接线本身**（谁把信号传给谁），
 * 并在 `docs/HANDOFF.md` 里如实写"端到端未验"。
 * 这样至少"有人顺手删掉 signal 那一行"会被立刻挡住。
 *
 * ⚠️ 判据是**接线**不是**存在**：只断言 `signal` 真的从 controller 流到 `agentTools`、
 * 从 env 流到 `runSubagent`、从 `runSubagent` 流到 `runTurn`。
 */

const ROOT = path.resolve(__dirname, "..");
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");

describe("C2-3 连线守卫：一份循环 + 中止信号穿三层", () => {
  it("① `ai:chat` 把 controller 的信号放进工具环境（也放进 runTurn）", () => {
    const src = read("electron/ipc/ai.ts");
    expect(src, "工具环境里没有 signal → 子智能体拿不到中止信号").toContain("signal: controller.signal");
    expect(src, "runTurn 那一路没有 abortSignal").toContain("abortSignal: controller.signal");
  });

  it("② 工具执行把信号交给子智能体", () => {
    const src = read("electron/ipc/tools.ts");
    expect(src, "ToolEnv 上没有 signal 字段").toContain("signal?: AbortSignal;");
    expect(src, "spawn_agent 没把 env.signal 传给 runSubagent").toContain("...(env.signal ? { signal: env.signal } : {})");
  });

  it("③ 子智能体用的是同一份循环，并把信号传下去", () => {
    const src = read("electron/ipc/subagent.ts");
    expect(src, "子智能体没有走 runTurn（那就是又长出一份循环）").toContain("runTurn(");
    expect(src, "runSubagent 没把 signal 传给 runTurn").toContain("...(input.signal ? { abortSignal: input.signal } : {})");
    expect(src, "子智能体又自己写了一份 streamText（第二份循环）").not.toContain("streamText(");
  });

  it("④ 步数上限是参数（父 4 / 子 6），两条路共用同一份循环", () => {
    const ai = read("electron/ipc/ai.ts");
    const sub = read("electron/ipc/subagent.ts");
    expect(ai, "父级的步数上限应当是 4（沿用原值，不许顺手统一）").toContain("maxSteps: 4");
    expect(sub, "子智能体的步数上限应当是 6（沿用原值）").toContain("maxSteps: input.maxSteps ?? 6");
    // 两份循环的痕迹：父级不该再直接 import streamText
    expect(ai, "ai.ts 又自己 import 了 streamText（第二份循环）").not.toContain("streamText");
    expect(ai + sub, "主循环应当只有 runTurn 一份实现").toContain("runTurn");
  });
});
