import { describe, expect, it } from "vitest";

import { CONFIRM_MODES, normalizeConfirmMode } from "./ipc";

/**
 * B-01：档位词表是**契约**。
 *
 * - 新增「接受编辑」必须被认出；
 * - 缺省/坏值仍然是「按需确认」（默认档不许被这次变更动到）。
 */
describe("B-01 · ConfirmMode 契约", () => {
  it("四个档位，顺序与界面一致", () => {
    expect(CONFIRM_MODES).toEqual(["全部允许", "接受编辑", "按需确认", "每步确认"]);
  });

  it("normalizeConfirmMode('接受编辑') 通过", () => {
    expect(normalizeConfirmMode("接受编辑")).toBe("接受编辑");
  });

  it("缺省与坏值仍回落「按需确认」", () => {
    for (const bad of [undefined, null, "", "acceptEdits", 1]) {
      expect(normalizeConfirmMode(bad)).toBe("按需确认");
    }
  });
});
