import { describe, expect, it } from "vitest";

import { evaluateRules, ruleFromApproval } from "@engine/core/permissionRules";
import type { PermissionRuleWire } from "@shared/review";
import { ruleKey, ruleRows, withoutRule } from "./PermissionRulesTable";

/**
 * F-04：设置里的权限规则表（2026-10-20）。
 *
 * 「总是允许」攒出来的规则原来**只写不读** —— 用户找不到怎么撤销。
 * 这里钉住三件事：三类规则都能列出来、键唯一、删除真的少一条。
 */

const now = 1_760_000_000_000;

const rules: PermissionRuleWire[] = [
  ruleFromApproval({ action: "run_command", input: { command: "git status" } }, { now, ttlDays: 7 }) as PermissionRuleWire,
  ruleFromApproval({ action: "write_file", input: { path: "D:/proj/src/a.ts" } }, { now, ttlDays: 7 }) as PermissionRuleWire,
  ruleFromApproval({ action: "mcp__github__create_issue", input: {} }, { now, ttlDays: 0 }) as PermissionRuleWire,
];

describe("ruleRows", () => {
  it("⭐ 三类规则（命令 / 文件目录 / MCP）都能列出来", () => {
    const rows = ruleRows(rules);
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.action)).toEqual(["run_command", "write_file", "mcp__github__create_issue"]);
    expect(rows.map((r) => r.effect)).toEqual(["允许", "允许", "允许"]);
  });

  it("命令只放行那一条原文；写文件放宽到目录；MCP 只放行服务器", () => {
    const rows = ruleRows(rules);
    expect(rows[0].resource).toBe("git status");
    expect(rows[1].resource).toBe("D:/proj/src/**");
    expect(rows[2].resource).toBe("github");
  });

  it("带来源（note）与过期时间；`ttlDays:0` 是长期", () => {
    const rows = ruleRows(rules);
    expect(rows[0].note).toContain("总是允许");
    expect(rows[0].expiresAt).toBe(now + 7 * 86_400_000);
    expect(rows[2].expiresAt).toBeUndefined();
  });

  /*
   * ⭐ 红测试留下的回归（2026-10-20）：MCP 规则原来也被追加 `/**`，
   * 写成 `github/**` 而实际资源是 `github` —— 规则存在、却永远不生效。
   * 用户点「总是允许」看到的是一句"以后这类不再问"，实际每次还问。
   */
  it("⭐ MCP 的「总是允许」规则真的匹配得上（不是一条死规则）", () => {
    const mcp = ruleFromApproval({ action: "mcp__github__create_issue", input: {} }, { now, ttlDays: 7 });
    expect(mcp.resource).toBe("github");
    expect(evaluateRules([mcp], "mcp__github__create_issue", "github", now)).toBe("allow");
  });
});

describe("withoutRule", () => {
  it("⭐ 按稳定键删掉一条，其余不动", () => {
    const key = ruleKey(rules[1]);
    const next = withoutRule(rules, key);
    expect(next).toHaveLength(2);
    expect(next.some((r) => ruleKey(r) === key)).toBe(false);
  });

  it("键对不上 → 原样返回（不误删）", () => {
    expect(withoutRule(rules, "不存在|*|allow")).toHaveLength(3);
  });
});
