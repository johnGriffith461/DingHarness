import { describe, expect, it } from "vitest";

import {
  PLAN_MODE_TOOLS,
  isPlanTransitionAllowed,
  planFilePath,
  planToolNames,
  renderPlanPrompt,
  type PlanState,
} from "./planMode";

/**
 * C1：计划模式的纯逻辑。
 * 两条最容易形同虚设的：跳过「等确认」直接执行；计划模式下写工具还在工具面里。
 */

describe("状态迁移", () => {
  it("正常路径：idle → planning → awaiting → executing → idle", () => {
    const path: PlanState[] = ["idle", "planning", "awaiting_approval", "executing", "idle"];
    for (let i = 0; i < path.length - 1; i += 1) {
      expect(isPlanTransitionAllowed(path[i]!, path[i + 1]!), `${path[i]} → ${path[i + 1]}`).toBe(true);
    }
  });

  it("⭐ 不许跳过等确认直接执行", () => {
    expect(isPlanTransitionAllowed("planning", "executing")).toBe(false);
    expect(isPlanTransitionAllowed("idle", "executing")).toBe(false);
  });

  it("执行中不能回到计划（先停/结束）", () => {
    expect(isPlanTransitionAllowed("executing", "planning")).toBe(false);
  });

  it("计划阶段可以取消回 idle", () => {
    expect(isPlanTransitionAllowed("planning", "idle")).toBe(true);
    expect(isPlanTransitionAllowed("awaiting_approval", "idle")).toBe(true);
  });
});

describe("工具面", () => {
  it("⭐ 计划模式的白名单里没有任何写/命令工具", () => {
    for (const forbidden of ["write_file", "edit_file", "apply_patch", "run_command", "spawn_agent"]) {
      expect(PLAN_MODE_TOOLS).not.toContain(forbidden);
    }
  });

  it("只读工具都在", () => {
    for (const allowed of ["read_file", "search_files", "list_dir", "list_files"]) {
      expect(PLAN_MODE_TOOLS).toContain(allowed);
    }
  });
});

describe("计划文件与提示", () => {
  it("路径在 .ding/plans 下，会话 id 不会逃逸", () => {
    const file = planFilePath("C:/data", "../../etc");
    expect(file).toContain(".ding/plans");
    expect(file).not.toContain("..");
  });

  it("提示里写清五段与「不要改文件」", () => {
    const text = renderPlanPrompt("重构登录");
    expect(text).toContain("<plan_mode>");
    for (const section of ["目标", "范围", "步骤", "验证", "风险"]) expect(text).toContain(section);
    expect(text).toContain("不能修改任何文件");
    expect(text).toContain("重构登录");
  });
});

describe("planToolNames（真正下发的名单）", () => {
  it("⭐ 不给 only 时也不含任何写工具", () => {
    const names = planToolNames();
    expect(names).toContain("read_file");
    expect(names).not.toContain("write_file");
    expect(names).not.toContain("run_command");
  });

  it("与角色白名单取交集（只会更窄）", () => {
    expect(planToolNames(["read_file", "write_file"])).toEqual(["read_file"]);
    expect(planToolNames(["write_file"])).toEqual([]);
  });
});
