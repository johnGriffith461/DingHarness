import { describe, expect, it } from "vitest";

import { baseNameOf, enabledSkillNames, recentFilesOf } from "./summaryData";
import type { WorkTask } from "./task";

/**
 * 守卫：右摘要那两块**不许再写死「暂无」**（2026-10-16，审计 P82）。
 *
 * 修前实测：输入区那条正渲染「启用了 3 个」的技能 chip，而右栏同一屏的「技能」写着「暂无」——
 * 同一个 store 的两个说法，用户只能怀疑其中一个在骗他。
 */
function taskWith(over: Partial<WorkTask>): WorkTask {
  return {
    id: "t1",
    brief: "b",
    title: "t",
    steps: [],
    artifacts: [],
    stage: "done",
    activity: "",
    startedAt: 1,
    finishedAt: 2,
    questions: [],
    questionIndex: 0,
    ...over,
  } as unknown as WorkTask;
}

describe("右摘要：技能与最近文件（P82）", () => {
  it("技能取的是**启用项**，与输入区那份 chip 同一个来源", () => {
    const lib = { enabled: ["builtin-a", "custom-x", "gone"] };
    const names = enabledSkillNames(lib, (id) => ({ "builtin-a": "查股价", "custom-x": "写周报" })[id]);
    expect(names, "查不到名字的不显示（悬空 id），但**不能因此整块说暂无**").toEqual(["查股价", "写周报"]);
  });

  it("最近文件从工具留痕里推出来：最近优先、去重、认 Windows 路径", () => {
    const task = taskWith({
      steps: [
        { id: "s1", role: "assistant", text: "看了第一个", at: 1, tools: [{ toolCallId: "c1", name: "read_file", ok: true, line: "读完了 D:\\报表\\一月.csv" }] },
        { id: "s2", role: "user", text: "再看看", at: 2 },
        { id: "s3", role: "assistant", text: "又看了两个", at: 3, tools: [
          { toolCallId: "c2", name: "read_file", ok: true, line: "读完了 D:\\报表\\二月.csv" },
          { toolCallId: "c3", name: "write_file", ok: true, line: "写了 D:\\out\\汇总.xlsx" },
        ] },
      ],
    } as Partial<WorkTask>);
    const got = recentFilesOf(task);
    expect(got.map((f) => f.name), "越靠后的步骤越新，所以二月与汇总在前").toEqual([
      "汇总.xlsx",
      "二月.csv",
      "一月.csv",
    ]);
    expect(got[0]!.path, "路径要原样留着（点开要看得到是哪个）").toContain("out");
  });

  it("同一份文件出现多次只算一条（大小写不敏感 —— Windows 上同一条路会以不同大小写出现）", () => {
    const task = taskWith({
      steps: [
        { id: "s1", role: "assistant", text: "a", at: 1, tools: [{ toolCallId: "c1", name: "read_file", ok: true, line: "读 D:\\A\\x.md" }] },
        { id: "s2", role: "assistant", text: "b", at: 2, tools: [{ toolCallId: "c2", name: "read_file", ok: true, line: "又读 d:\\a\\X.MD" }] },
      ],
    } as Partial<WorkTask>);
    expect(recentFilesOf(task)).toHaveLength(1);
  });

  it("资料（@ 添加的）算最近文件——那是用户明确指给这次任务的", () => {
    const task = taskWith({ material: "用户提到：D:\\资料\\需求.md 这份", steps: [] } as Partial<WorkTask>);
    expect(recentFilesOf(task).map((f) => f.name)).toEqual(["需求.md"]);
  });

  it("没有任何痕迹时才是空（这时面板说暂无是对的）", () => {
    expect(recentFilesOf(taskWith({}))).toEqual([]);
    expect(enabledSkillNames({ enabled: [] }, () => undefined)).toEqual([]);
  });

  it("文件名提取认两种分隔符", () => {
    expect(baseNameOf("D:\\报表\\一月.csv")).toBe("一月.csv");
    expect(baseNameOf("/home/me/a.md")).toBe("a.md");
  });
});
