import { describe, expect, it } from "vitest";

import type { ToolTrace } from "@shared/agentTools";
import { countEditAsks, hasPendingEdit, shouldOfferBulkAccept } from "./confirmFatigue";

/**
 * F-04：确认疲劳的逃生门（2026-10-20）。
 *
 * 判据只有四条：第 3 次、还没提示过、当前档位是会逐次问的那两档、且确实有一条待批编辑。
 * 少一条就会变成"已经全允许了还劝你自动接受"或者"每一条都弹一次"。
 */

const trace = (name: string, pending = true): ToolTrace => ({
  toolCallId: `${name}-1`,
  name,
  ok: !pending,
  line: name,
  pending,
});

describe("shouldOfferBulkAccept", () => {
  it("⭐ 第 3 次编辑（按需确认档）→ 提示", () => {
    expect(shouldOfferBulkAccept({ editsAsked: 3, alreadyOffered: false, mode: "按需确认" })).toBe(true);
    expect(shouldOfferBulkAccept({ editsAsked: 4, alreadyOffered: false, mode: "每步确认" })).toBe(true);
  });

  it("不到 3 次 → 不提示", () => {
    expect(shouldOfferBulkAccept({ editsAsked: 2, alreadyOffered: false, mode: "按需确认" })).toBe(false);
  });

  it("已经是「接受编辑」/「全部允许」→ 不提示（编辑本来就不问）", () => {
    expect(shouldOfferBulkAccept({ editsAsked: 9, alreadyOffered: false, mode: "接受编辑" })).toBe(false);
    expect(shouldOfferBulkAccept({ editsAsked: 9, alreadyOffered: false, mode: "全部允许" })).toBe(false);
  });

  it("⭐ 已经提示过（点了哪个按钮都算）→ 不再提示", () => {
    expect(shouldOfferBulkAccept({ editsAsked: 9, alreadyOffered: true, mode: "按需确认" })).toBe(false);
  });
});

describe("countEditAsks / hasPendingEdit", () => {
  const steps = [
    { tools: [trace("write_file", false), trace("run_command", false)] },
    { tools: [trace("edit_file", true), trace("read_file", false)] },
    { tools: [trace("apply_patch", false)] },
  ];

  it("只数编辑类工具（write/edit/apply_patch），命令与读不算", () => {
    expect(countEditAsks(steps)).toBe(3);
  });

  it("有任一条**待批**编辑才算（都批完了就不弹了）", () => {
    expect(hasPendingEdit(steps)).toBe(true);
    expect(hasPendingEdit([{ tools: [trace("write_file", false)] }])).toBe(false);
    expect(hasPendingEdit([{ tools: [trace("run_command", true)] }])).toBe(false);
  });
});
