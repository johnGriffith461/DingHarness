import { describe, expect, it } from "vitest";

import {
  PLAN_MODE_TOOLS,
  PLAN_TEXT_LIMIT,
  isPlanTransitionAllowed,
  missingPlanSections,
  planFilePath,
  planToolNames,
  renderApprovedPlan,
  renderPlanPrompt,
  truncatePlan,
  writePlanFile,
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

describe("计划落盘（G1）", () => {
  const full = ["1. 目标：能跑", "2. 范围：src", "3. 步骤：改两处", "4. 验证：pnpm test", "5. 风险：回滚 commit"].join("\n");

  it("五段齐全时缺段为空；缺一段能指出来", () => {
    expect(missingPlanSections(full)).toEqual([]);
    expect(missingPlanSections(full.replace(/^4\..*$/m, ""))).toEqual(["验证"]);
  });

  it("正文里顺口提「风险」不算那一段", () => {
    expect(missingPlanSections("目标：做一件事，可能有点风险")).toContain("风险");
  });

  it("超 20 KiB 截断并标记", () => {
    const got = truncatePlan("x".repeat(PLAN_TEXT_LIMIT + 10));
    expect(got.truncated).toBe(true);
    expect(got.text.length).toBe(PLAN_TEXT_LIMIT);
  });

  it("写到 .ding/plans 下，内容与传入一致", async () => {
    const writes: Array<{ path: string; text: string }> = [];
    const got = await writePlanFile("C:/data", "t-1", full, async (path, text) => {
      writes.push({ path, text });
    });
    expect(got.ok).toBe(true);
    if (got.ok) expect(got.path).toContain(".ding/plans/t-1.md");
    expect(writes).toHaveLength(1);
    expect(writes[0]!.text).toBe(full);
  });

  it("非法 sessionId 被清洗，不会逃出计划目录", async () => {
    let written = "";
    await writePlanFile("C:/data", "../../etc/passwd", "目标：x", async (path) => {
      written = path;
    });
    expect(written).not.toContain("..");
    expect(written).toContain(".ding/plans/");
  });

  it("写失败返回可读错误（不抛）", async () => {
    const got = await writePlanFile("C:/data", "t-1", full, async () => {
      throw new Error("磁盘满了");
    });
    expect(got.ok).toBe(false);
    if (!got.ok) {
      expect(got.error).toContain("磁盘满了");
      expect(got.path).toContain(".ding/plans");
    }
  });

  it("空计划拒绝写", async () => {
    const got = await writePlanFile("C:/data", "t-1", "   ", async () => undefined);
    expect(got.ok).toBe(false);
  });

  it("批准后的注入块带路径与计划正文", () => {
    const block = renderApprovedPlan(full, "C:/p/.ding/plans/t-1.md");
    expect(block).toContain("<approved_plan>");
    expect(block).toContain("计划文件：C:/p/.ding/plans/t-1.md");
    expect(block).toContain("步骤：改两处");
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
