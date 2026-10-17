import { describe, expect, it } from "vitest";

import { parseWorkflowDsl, workflowToDsl } from "./dsl";
import { AGENT_SPECS } from "../runtime/agents";

/**
 * 工作流 DSL（L03）。
 *
 * 判据：阶段顺序自动成依赖、同阶段并行、坏输入**拒绝而不是半份定义**、往返一致。
 */

const known = AGENT_SPECS[0]!.name;

describe("解析（parseWorkflowDsl）", () => {
  it("⭐ 两个阶段：第二阶段依赖第一阶段", () => {
    const got = parseWorkflowDsl(`name: 周报\n\nphase 调研\n  agent ${known} 收集数据\n\nphase 写作\n  agent ${known} 写周报`);
    expect(got.ok).toBe(true);
    if (!got.ok) return;
    expect(got.spec.name).toBe("周报");
    expect(got.spec.steps.map((s) => s.id)).toEqual(["调研#1", "写作#1"]);
    expect(got.spec.steps[1]?.dependsOn).toEqual(["调研#1"]);
  });

  it("⭐ 同一阶段两步并行（都不依赖对方，依赖同一个上游）", () => {
    const got = parseWorkflowDsl(
      `phase 调研\n  agent ${known} A\n\nphase 写作 after 调研\n  agent ${known} B\n  agent ${known} C`,
    );
    expect(got.ok).toBe(true);
    if (!got.ok) return;
    const b = got.spec.steps.find((s) => s.id === "写作#1");
    const c = got.spec.steps.find((s) => s.id === "写作#2");
    expect(b?.dependsOn).toEqual(["调研#1"]);
    expect(c?.dependsOn).toEqual(["调研#1"]);
  });

  it("⭐ 不认识的专家名 → 拒绝，并列出可用名单", () => {
    const got = parseWorkflowDsl("phase p\n  agent 不存在的角色 干啥");
    expect(got.ok).toBe(false);
    if (got.ok) return;
    expect(got.problems.join("\n")).toContain("不认识的专家");
    expect(got.problems.join("\n")).toContain(known);
  });

  it("⭐ after 指向不存在的阶段 → 拒绝", () => {
    const got = parseWorkflowDsl(`phase a\n  agent ${known} x\n\nphase b after 不存在\n  agent ${known} y`);
    expect(got.ok).toBe(false);
    if (!got.ok) expect(got.problems.join("\n")).toContain("不存在的阶段");
  });

  it("空阶段 / 没有阶段 / 不认识的语法都被拒", () => {
    for (const text of ["", "phase a", "随便写点什么"]) {
      expect(parseWorkflowDsl(text).ok, text).toBe(false);
    }
  });

  it("注释与空行被忽略；`-` 也能当步骤前缀", () => {
    const got = parseWorkflowDsl(`// 这是注释\nphase 一\n\n  - ${known} 任务`);
    expect(got.ok).toBe(true);
    if (got.ok) expect(got.spec.steps).toHaveLength(1);
  });

  it("mode 只认三个档位（其它值忽略而不是报错）", () => {
    const got = parseWorkflowDsl(`mode: 乱写\nphase 一\n  agent ${known} x`);
    expect(got.ok).toBe(true);
    if (got.ok) expect(got.spec.mode).toBeUndefined();
  });
});

describe("反写（workflowToDsl）", () => {
  it("⭐ 解析 → 反写 → 再解析：步骤与依赖一致", () => {
    const text = `name: 流水线\ndesc: 三步\nphase 调研\n  agent ${known} 收集\n\nphase 写作 after 调研\n  agent ${known} 写\n\nphase 审阅 after 写作\n  agent ${known} 审`;
    const first = parseWorkflowDsl(text);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const dsl = workflowToDsl(first.spec);
    const second = parseWorkflowDsl(dsl);
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.spec.steps.map((s) => [s.id, s.agent, s.dependsOn ?? []])).toEqual(
      first.spec.steps.map((s) => [s.id, s.agent, s.dependsOn ?? []]),
    );
    expect(second.spec.name).toBe(first.spec.name);
  });
});
