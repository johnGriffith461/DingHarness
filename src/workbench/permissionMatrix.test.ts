import { describe, expect, it } from "vitest";

import { MEMBER_ROLES } from "@engine/core/members";
import { decideForMember } from "@engine/core/policy";
import { matrixRows, verdictHint } from "./permissionMatrix";

/**
 * 两轴权限矩阵页的数据层（V6-2i / V6-4d）。
 *
 * 这条测试的核心不是"格子长什么样"，而是**页面与内核不许分叉**：
 * 每一格都必须等于 `decideForMember` 的判定。界面自己写规则，
 * 迟早会变松（那才是危险的方向）。
 */

describe("矩阵行", () => {
  it("⭐ 每一格都等于内核判定（页面不另写规则）", () => {
    for (const mode of ["全部允许", "按需确认", "每步确认"] as const) {
      for (const row of matrixRows(mode)) {
        for (const role of MEMBER_ROLES) {
          expect(row.cells[role], `${mode} / ${row.tool} / ${role}`).toBe(
            decideForMember({ roles: [role] }, mode, row.tool).verdict,
          );
        }
      }
    }
  });

  it("只读成员写操作在「全部允许」档下也拒（角色是上限，档位是旋钮）", () => {
    const rows = matrixRows("全部允许");
    const write = rows.find((r) => r.tool === "write_file")!;
    expect(write.kind).toBe("write");
    expect(write.cells.owner).toBe("run");
    expect(write.cells.viewer).toBe("deny");
  });

  it("只读操作不受人轴影响（拦只读会让只读成员什么都干不了）", () => {
    const rows = matrixRows("按需确认");
    const read = rows.find((r) => r.tool === "read_file")!;
    expect(read.cells.owner).toBe("run");
    expect(read.cells.viewer).toBe("run");
  });

  it("「每步确认」档下读也要问（那一档的定义就是无论读写都问）", () => {
    const rows = matrixRows("每步确认");
    const read = rows.find((r) => r.tool === "read_file")!;
    expect(read.cells.owner).toBe("ask");
    expect(read.cells.viewer).toBe("ask");
  });

  it("行顺序：只读在前、写在后（表格好读，且不随对象键顺序漂）", () => {
    const rows = matrixRows("按需确认");
    const firstWrite = rows.findIndex((r) => r.kind === "write");
    expect(rows.slice(0, firstWrite).every((r) => r.kind === "read")).toBe(true);
    expect(rows.slice(firstWrite).every((r) => r.kind === "write")).toBe(true);
  });

  it("每一格都有悬停说明（为什么，不是重复判定名）", () => {
    for (const mode of ["全部允许", "按需确认"] as const) {
      for (const row of matrixRows(mode)) {
        for (const role of MEMBER_ROLES) {
          const hint = verdictHint(row.cells[role], role, row.kind);
          expect(hint.length).toBeGreaterThan(4);
        }
      }
    }
  });
});
