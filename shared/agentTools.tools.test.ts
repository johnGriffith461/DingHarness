import { describe, expect, it } from "vitest";

import { AGENT_TOOLS, RUN_COMMAND_INPUT, toolSpec } from "./agentTools";
import { CLI_TOOLS } from "../hosts/cli/assembly";
import { ALWAYS_TOOLS } from "../engine/runtime/toolSearch";

/**
 * B-03/B-04：新工具必须**三处都在**。
 *
 * 上一轮实测过一次：`todo_write` / `finish` / `ask_user` 进了 `AGENT_TOOLS`，
 * 却漏了 `CLI_TOOLS` 与 `ALWAYS_TOOLS` —— 模型在回复里说
 * "我这边实际可用的工具里没有 todo_write 和 finish"。
 * 手工清单会漏，所以让机器对账。
 */
const NEW_TOOLS = ["job_output", "job_kill", "web_fetch"] as const;

describe("新工具的三处清单", () => {
  for (const name of NEW_TOOLS) {
    it(`${name}：在 AGENT_TOOLS、CLI_TOOLS、ALWAYS_TOOLS 里各出现一次`, () => {
      expect(AGENT_TOOLS.filter((t) => t.name === name), "AGENT_TOOLS").toHaveLength(1);
      expect(CLI_TOOLS.filter((t) => t === name), "CLI_TOOLS").toHaveLength(1);
      expect(ALWAYS_TOOLS.filter((t) => t === name), "ALWAYS_TOOLS").toHaveLength(1);
    });

    it(`${name}：有调度元数据（TOOL_META 生效）`, () => {
      expect(toolSpec(name)?.meta, "没有 meta 的工具会掉到保守默认").toBeTruthy();
    });
  }

  it("run_command 的 schema 接受 background 与 stdin（B-02/B-03 的入口）", () => {
    const parsed = RUN_COMMAND_INPUT.safeParse({ command: "node x.js", stdin: "hi", background: true });
    expect(parsed.success).toBe(true);
  });

  it("stdin 超过 64 KiB 被 schema 拦下（执行体还有一道字节闸）", () => {
    const parsed = RUN_COMMAND_INPUT.safeParse({ command: "x", stdin: "a".repeat(64 * 1024 + 1) });
    expect(parsed.success).toBe(false);
  });
});
