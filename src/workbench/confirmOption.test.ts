import { describe, expect, it } from "vitest";

import { confirmOptionState } from "./confirmMode";

/**
 * T-06：档位弹层里**只有一个勾**。
 *
 * 缺陷形状（Workbench 截图 + 源码）：每个选项前面都渲染了一个 `<Check>` 图标，
 * 选中项再追加一个 —— 三个选项全都有勾，用户看不出自己在哪一档。
 */
describe("confirmOptionState", () => {
  const modes = ["全部允许", "按需确认", "每步确认"] as const;

  it("当前档位是唯一的选中项", () => {
    for (const current of modes) {
      const states = modes.map((m) => confirmOptionState(m, current));
      expect(states.filter((s) => s.checked)).toHaveLength(1);
      expect(states[modes.indexOf(current)]?.checked).toBe(true);
    }
  });

  it("非选中项不显示勾（也不显示任何勾选态图标）", () => {
    const other = confirmOptionState("全部允许", "每步确认");
    expect(other.checked).toBe(false);
    expect(other.marker).toBe("none");
  });

  it("选中项标记为「check」", () => {
    expect(confirmOptionState("每步确认", "每步确认").marker).toBe("check");
  });
});
