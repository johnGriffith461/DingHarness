import { assessCommand, type CommandAssessment } from "./commandRisk";

/**
 * **权限规则 v1**（U03，2026-10-18）。
 *
 * ## 它替代了什么
 *
 * 判定层原来只看两件事：**工具名** + **档位**（读/写在不在 `TOOL_POLICY` 表里）。
 * 于是：
 * - `git status` 和 `git push --force` 是同一条规则（都叫 `run_command`，都问）；
 * - `write_file src/a.ts` 和 `write_file C:\Windows\System32\x.dll` 也是同一条
 *   （后者其实被目录白名单拦，但**判定层**完全不知道路径）；
 * - 用户想"这一类以后别再问"时，没有地方存这个决定。
 *
 * 现在：规则是 `{action, resource, effect}`：
 *
 * ```jsonc
 * { "action": "run_command", "resource": "git *", "effect": "allow" }
 * { "action": "write_file",  "resource": "src/**", "effect": "allow" }
 * { "action": "*",           "resource": "**\/*.env", "effect": "deny" }
 * ```
 *
 * ## 五条口径
 *
 * 1. **`findLast`**：后写的规则覆盖先写的（用户后加的意图更准确）。
 * 2. **没有匹配 → `ask`**：不知道就问，这是安全的那一侧。
 *    ⚠️ 它与 `TOOL_POLICY` 的"未声明默认只读放行"**不冲突**：那一层决定
 *    "档位下要不要问"，这一层是**用户显式规则**；规则没命中时回落到档位判定。
 * 3. **`deny` 永远优先**：任何一条匹配的 deny 都压过 allow ——
 *    否则"先 allow 一个大目录、再 deny 里面的密钥文件"这种最常见的写法就不成立。
 * 4. **`expiresAt`**：持久放行可以带有效期（默认 7 天）。过期的规则不参与判定。
 * 5. **危险命令抬升**：`run_command` 命中高风险分析时，**即使档位是「全部允许」**
 *    也回 `ask` —— 除非有一条显式的 allow 规则覆盖它（那是用户写下来的决定）。
 */

/** 一条规则。 */
export type PermissionRule = {
  /** 工具名，或 `*`（所有工具）。 */
  action: string;
  /** 资源 glob：命令文本 / 文件路径 / `mcp__server`；省略 = 匹配该 action 的一切。 */
  resource?: string;
  effect: "allow" | "deny" | "ask";
  /** 过期时间（epoch ms）。省略 = 长期有效。 */
  expiresAt?: number;
  /** 为什么加这条（给人看；`save` 时写"用户在审批卡片上选了总是允许"）。 */
  note?: string;
};

/** 持久放行的默认有效期：7 天。 */
export const RULE_DEFAULT_TTL_MS = 7 * 86_400_000;

/** 判定结果。 */
export type RuleVerdict = "allow" | "deny" | "ask" | "none";

/**
 * glob → 正则。
 *
 * 只支持三种通配，别把它当完整 glob：
 * - `*` 匹配**除路径分隔符外**的任意串；
 * - `**` 匹配任意串（含 `/`）；
 * - `?` 匹配一个字符。
 *
 * 为什么不用第三方 glob：这里要判的是**权限**，规则语义必须小到能一眼看懂；
 * 完整 glob 的 `{a,b}` / `[!x]` 会把"这条规则到底匹配什么"变成需要查文档的事。
 *
 * @param glob 规则里的资源模式
 */
export function globToRegExp(glob: string): RegExp {
  let out = "^";
  for (let i = 0; i < glob.length; i += 1) {
    const ch = glob[i]!;
    if (ch === "*") {
      if (glob[i + 1] === "*") {
        out += ".*";
        i += 1;
        /* 双星后紧跟斜杠时，也要匹配"零层目录" */
        if (glob[i + 1] === "/") {
          out += "/?";
          i += 1;
        }
      } else {
        out += "[^/\\\\]*";
      }
      continue;
    }
    if (ch === "?") {
      out += ".";
      continue;
    }
    out += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`${out}$`);
}

/** 这条规则匹配不匹配这次调用。 */
function matches(rule: PermissionRule, action: string, resource: string): boolean {
  if (rule.action !== "*" && rule.action !== action) return false;
  if (rule.resource === undefined || rule.resource === "*") return true;
  return globToRegExp(rule.resource).test(resource);
}

/**
 * 评估一批规则。
 *
 * @param rules 规则（顺序即优先级）
 * @param action 工具名
 * @param resource 资源（命令文本 / 路径 / 服务器名）
 * @param now 现在（测试用；过期规则被跳过）
 * @returns `allow` / `deny` / `ask`；没有规则命中给 `none`（调用方回落到档位判定）
 */
export function evaluateRules(
  rules: readonly PermissionRule[],
  action: string,
  resource: string,
  now: number = Date.now(),
): RuleVerdict {
  const live = rules.filter((rule) => rule.expiresAt === undefined || rule.expiresAt > now);
  const matched = live.filter((rule) => matches(rule, action, resource));
  if (!matched.length) return "none";
  /* deny 永远优先（口径 3）：否则"allow 大目录 + deny 里面的密钥"就不成立 */
  if (matched.some((rule) => rule.effect === "deny")) return "deny";
  /* findLast（口径 1） */
  return matched[matched.length - 1]!.effect;
}

/**
 * 从一次工具调用里取出**资源**（规则要匹配的那段文本）。
 *
 * @param action 工具名
 * @param input 模型给的参数（不可信）
 */
export function resourceOf(action: string, input: unknown): string {
  const obj = (input ?? {}) as Record<string, unknown>;
  if (action === "run_command") return typeof obj.command === "string" ? obj.command : "";
  if (["write_file", "edit_file", "read_file", "list_dir", "search_files"].includes(action)) {
    return typeof obj.path === "string" ? obj.path : "";
  }
  if (action.startsWith("mcp__")) {
    /* `mcp__<server>__<tool>` */
    const rest = action.slice("mcp__".length);
    const at = rest.indexOf("__");
    return at > 0 ? rest.slice(0, at) : rest;
  }
  return "";
}

/** 一次判定的完整结论（给闸门用）。 */
export type CallDecision = {
  /** 最终该干什么（与 `Verdict` 同一个词表）。 */
  verdict: "run" | "ask" | "hide";
  /** 规则命中时的那个 effect（`none` = 没有规则命中，走了档位）。 */
  rule: RuleVerdict;
  /** 命令风险分析（只有 `run_command` 有）。 */
  command?: CommandAssessment;
  /** 为什么是这个结论（给审批卡片/审计）。 */
  why?: string;
};

/**
 * 把「档位判定」与「规则 / 命令风险」合成一个结论。
 *
 * @param input 输入
 */
export function decideCall(input: {
  /** 档位给出的基础判定（`decide()` 的结果） */
  base: "run" | "ask" | "hide";
  action: string;
  input?: unknown;
  rules?: readonly PermissionRule[];
  now?: number;
  /** 命令分析的覆盖（测试用） */
  assessment?: CommandAssessment;
}): CallDecision {
  if (input.base === "hide") return { verdict: "hide", rule: "none" };
  const resource = resourceOf(input.action, input.input);
  const rule = evaluateRules(input.rules ?? [], input.action, resource, input.now);
  const command =
    input.action === "run_command"
      ? (input.assessment ?? assessCommand(typeof (input.input as { command?: unknown })?.command === "string" ? String((input.input as { command?: string }).command) : ""))
      : undefined;

  if (rule === "deny") return { verdict: "ask", rule, ...(command ? { command } : {}), why: "有 deny 规则命中 —— 需要用户明确放行" };
  /*
   * `deny` 在闸门这一层的表示是 `ask`（不是静默执行）：让用户**看见**这条规则拦了什么，
   * 并且能就地覆盖。真正的 deny → 拒绝执行属于成员角色轴（`decideForMember` 的 viewer）。
   * 这条区别写在 ADR-007 的口径里：人轴的 deny 是"你不该做"，规则轴的 deny 是"这里要问"。
   */
  if (rule === "allow") return { verdict: "run", rule, ...(command ? { command } : {}) };
  if (rule === "ask") return { verdict: "ask", rule, ...(command ? { command } : {}), why: "有 ask 规则命中" };
  if (command && command.level === "high") {
    return {
      verdict: "ask",
      rule,
      command,
      why: `危险命令（${command.reasons.join("；") || "无法解析"}）—— 即使全部允许也要先问一次`,
    };
  }
  return { verdict: input.base, rule, ...(command ? { command } : {}) };
}

/**
 * 从"用户在审批卡片上选了总是允许"生成一条规则。
 *
 * @param input 那次调用的工具与参数
 * @param opts.ttlDays 有效期（默认 7 天；0 = 不过期）
 * @param opts.now 现在（测试用）
 */
export function ruleFromApproval(
  input: { action: string; input?: unknown },
  opts: { ttlDays?: number; now?: number } = {},
): PermissionRule {
  const now = opts.now ?? Date.now();
  const ttlDays = opts.ttlDays ?? 7;
  const resource = resourceOf(input.action, input.input);
  /*
   * 命令只放行**那一条**（原文），不做前缀通配 ——
   * `git status` 的"总是允许"不该变成"所有 git 都允许"。
   * 目录类资源放宽到所在目录：用户点"总是允许写这里"，意图是"这个目录可以写"。
   */
  const pattern =
    input.action === "run_command"
      ? resource
      : input.action.startsWith("mcp__")
        ? resource
        : resource.replace(/[/\\][^/\\]*$/, "") || resource;
  return {
    action: input.action,
    ...(pattern ? { resource: input.action === "run_command" ? pattern : `${pattern.replace(/[/\\]+$/, "")}/**` } : {}),
    effect: "allow",
    ...(ttlDays > 0 ? { expiresAt: now + ttlDays * 86_400_000 } : {}),
    note: "用户在审批时选了「总是允许」",
  };
}

/** 磁盘/配置里读回来的规则（**不可信**）→ 干净的规则表。 */
export function normalizeRules(raw: unknown): PermissionRule[] {
  if (!Array.isArray(raw)) return [];
  const out: PermissionRule[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const r = item as Record<string, unknown>;
    if (typeof r.action !== "string" || !r.action.trim()) continue;
    if (r.effect !== "allow" && r.effect !== "deny" && r.effect !== "ask") continue;
    out.push({
      action: r.action.trim(),
      ...(typeof r.resource === "string" && r.resource.trim() ? { resource: r.resource.trim() } : {}),
      effect: r.effect,
      ...(typeof r.expiresAt === "number" && Number.isFinite(r.expiresAt) ? { expiresAt: r.expiresAt } : {}),
      ...(typeof r.note === "string" && r.note.trim() ? { note: r.note.trim() } : {}),
    });
  }
  return out;
}

/** 给界面/CLI 的一句话。 */
export function describeRule(rule: PermissionRule): string {
  const effect = rule.effect === "allow" ? "允许" : rule.effect === "deny" ? "拒绝（改为询问）" : "总是询问";
  const res = rule.resource ?? "*";
  const exp = rule.expiresAt ? `，${new Date(rule.expiresAt).toLocaleString("zh-CN")} 过期` : "，长期有效";
  return `${rule.action} ← ${res}：${effect}${exp}${rule.note ? `（${rule.note}）` : ""}`;
}
