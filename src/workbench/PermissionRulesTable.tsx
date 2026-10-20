import type { PermissionRuleWire } from "@shared/review";
import { useAppSettings } from "./appSettings";

/**
 * F-04（2026-10-20）：**「总是允许」攒下的规则，能看、能撤**。
 *
 * ## 它补的是什么
 *
 * 审批卡上的「总是允许」会写一条长期规则（`ruleFromApproval`，默认 7 天过期），
 * 但设置里没有任何地方把它列出来 —— 用户点过之后**找不到怎么撤销**，
 * 于是"我允许过一次"变成了"我永远允许"。这在第一小时里是很典型的信任破坏：
 * 点错一次，唯一的补救是去翻 `settings.json`。
 *
 * ## 一行有什么
 *
 * 工具、资源、效果、来源（`note`）、过期时间。没有的字段如实空着，不编。
 */

export type RuleRow = {
  key: string;
  action: string;
  resource: string;
  effect: "允许" | "拒绝（改为询问）" | "总是询问";
  note: string;
  expiresAt?: number;
};

/** 规则 → 表格行（纯函数：单测直接钉）。 */
export function ruleRows(rules: readonly PermissionRuleWire[]): RuleRow[] {
  return rules.map((r) => ({
    key: ruleKey(r),
    action: r.action,
    resource: r.resource ?? "*",
    effect: r.effect === "allow" ? "允许" : r.effect === "deny" ? "拒绝（改为询问）" : "总是询问",
    note: r.note ?? "",
    ...(typeof r.expiresAt === "number" ? { expiresAt: r.expiresAt } : {}),
  }));
}

/** 规则的稳定键（与 `addRule` / `removeRule` 的去重口径一致）。 */
export function ruleKey(rule: PermissionRuleWire): string {
  return `${rule.action}|${rule.resource ?? "*"}|${rule.effect}`;
}

/** 删除一条之后的新数组（纯函数；键对不上就原样返回）。 */
export function withoutRule(rules: readonly PermissionRuleWire[], key: string): PermissionRuleWire[] {
  return rules.filter((r) => ruleKey(r) !== key);
}

function expiresLabel(at: number | undefined): string {
  if (!at) return "长期";
  try {
    return new Date(at).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
  } catch {
    return "有期限";
  }
}

export function PermissionRulesTable() {
  const rules = useAppSettings((s) => s.rules);
  const removeRule = useAppSettings((s) => s.removeRule);
  const note = useAppSettings((s) => s.note);

  return (
    <div className="wb-rules-table" data-testid="wb-rules-table">
      <div className="wb-setpage-row">
        <span className="wb-setpage-label">权限规则</span>
        <em data-testid="wb-rules-count">{rules.length === 0 ? "还没有「总是允许」的规则" : `${rules.length} 条`}</em>
      </div>
      {ruleRows(rules).map((row) => (
        <div className="wb-setpage-row wb-rule-row" key={row.key} data-testid={`wb-rule-${row.key}`}>
          <span className="wb-rule-main">
            <b>{row.action}</b>
            <code>{row.resource}</code>
          </span>
          <span className="wb-rule-meta">
            {row.effect} · {expiresLabel(row.expiresAt)}
            {row.note ? ` · ${row.note}` : ""}
          </span>
          <button
            className="wb-setpage-btn"
            data-testid={`wb-rule-remove-${row.key}`}
            onClick={() => {
              const target = rules.find((r) => ruleKey(r) === row.key);
              if (target) void removeRule(target);
            }}
          >
            删除
          </button>
        </div>
      ))}
      {note ? (
        <div className="wb-setpage-hint" data-testid="wb-rules-note">
          {note}
        </div>
      ) : null}
      <div className="wb-setpage-hint">
        这些规则来自审批卡上的「总是允许」，到期会自动失效；删掉之后同类调用会重新问你。
      </div>
    </div>
  );
}
