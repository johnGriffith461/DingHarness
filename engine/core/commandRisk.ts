/**
 * **危险命令分析**（U03，2026-10-18）。
 *
 * ## 为什么需要它
 *
 * 在这之前，`run_command` 的风险判定只有一档：按需确认档一律问、
 * 全部允许档一律不问。问题在第二种：用户选"全部允许"是信任**日常命令**
 * （`git status`、`npm test`），不是"随便 `rm -rf /`"。
 * 成熟 harness（Claude Code / Codex / Cline）都有一条命令级红线。
 *
 * ## 口径
 *
 * - **lexer 先分词**：引号、转义、分隔符（`;` `&&` `||` `|` 换行）；
 * - 规则按**词边界**匹配（不做子串匹配 —— `firmware` 不该被 `rm` 的规则命中）；
 * - **解析失败 → 高风险**：引号不闭合、出现无法识别的转义时，宁可当危险；
 *   一条"看不懂的命令"直接放行是最坏的那种默认。
 *
 * ## 这一版**不做**的事（如实）
 *
 * - 不做完整 AST（`$(...)`、反引号嵌套只做展开识别，不还原执行树）；
 * - 不做参数级语义分析（`rm -rf` 与 `rm -fr` 都靠规则表，不靠组合推导）；
 * - 不阻止危险命令，只把它标成 `high` 交给闸门 —— 拦不拦是策略（见 `permissionRules.ts`）。
 */

/** 风险等级。 */
export type CommandRisk = "low" | "medium" | "high";

/** 一次命令分析的结论。 */
export type CommandAssessment = {
  level: CommandRisk;
  /** 命中的规则/理由（给人看，也给审计留痕）。 */
  reasons: string[];
  /** 词法解析成功没有。失败一律按 high。 */
  parsed: boolean;
};

/** 一条规则。 */
type Rule = {
  id: string;
  level: CommandRisk;
  /** 命令段里的第一个词（或整段正则，二者取一）。 */
  argv0?: string;
  /** 段内必须同时出现的词（all-of）。 */
  all?: readonly string[];
  /** 段内任一出现即可（any-of）。 */
  any?: readonly string[];
  /** 整段（去引号后）匹配的正则。 */
  pattern?: RegExp;
  reason: string;
};

/**
 * 规则表。
 *
 * 每条都对着一件"数据会没"或"机器会被交出去"的事。宁可多标几条 medium，
 * 也不要漏掉 `curl | bash` 这种一句话就能接管机器的形态。
 */
const RULES: readonly Rule[] = [
  /* `rm -rf` / `rm -fr` / `rm -r` —— 递归删除本身就是"可能不可逆" */
  { id: "rm-recursive", level: "high", argv0: "rm", any: ["-rf", "-fr", "-r", "-R", "--recursive"], reason: "递归删除（可能不可逆）" },
  { id: "rm-force", level: "medium", argv0: "rm", any: ["-f", "--force"], reason: "强制删除（不给确认）" },
  { id: "rmdir-recursive", level: "medium", argv0: "rmdir", all: ["-p"], reason: "递归删目录" },
  { id: "del-recursive", level: "high", argv0: "del", any: ["/s", "/f", "/q"], reason: "Windows 递归强制删除" },
  { id: "rd-recursive", level: "high", argv0: "rd", any: ["/s", "/q"], reason: "Windows 递归删目录" },
  { id: "remove-item", level: "high", argv0: "remove-item", any: ["-recurse", "-force"], reason: "PowerShell 递归强制删除" },
  { id: "format", level: "high", argv0: "format", reason: "格式化磁盘" },
  { id: "mkfs", level: "high", pattern: /\bmkfs(\.\w+)?\b/i, reason: "创建文件系统（会清盘）" },
  { id: "dd-of-device", level: "high", argv0: "dd", pattern: /\bof=\/dev\//, reason: "直接写块设备" },
  { id: "diskpart", level: "high", argv0: "diskpart", reason: "磁盘分区工具" },
  { id: "shutdown", level: "medium", argv0: "shutdown", reason: "关机/重启" },
  { id: "reboot", level: "medium", argv0: "reboot", reason: "重启机器" },
  { id: "drop-database", level: "high", pattern: /\bdrop\s+database\b/i, reason: "删库" },
  { id: "truncate-table", level: "high", pattern: /\btruncate\s+table\b/i, reason: "清空表" },
  { id: "chmod-777-root", level: "medium", pattern: /chmod\s+-R\s+777\s+\//, reason: "递归放开根目录权限" },
  { id: "chown-root", level: "medium", pattern: /chown\s+-R\s+\S+\s+\//, reason: "递归改根目录属主" },
  { id: "git-force-push", level: "high", pattern: /\bgit\s+push\b[^&|;]*(\s--force|\s-f\b|--force-with-lease)/i, reason: "强推（可能覆盖远端历史）" },
  { id: "git-reset-hard", level: "medium", pattern: /\bgit\s+reset\b[^&|;]*--hard\b/i, reason: "硬重置（丢弃本地改动）" },
  { id: "git-clean-force", level: "medium", pattern: /\bgit\s+clean\b[^&|;]*\s-\w*f/i, reason: "清理未跟踪文件" },
  { id: "npm-publish", level: "medium", pattern: /\bnpm\s+publish\b/i, reason: "发布到 npm（对外动作）" },
  { id: "curl-pipe-shell", level: "high", pattern: /\b(curl|wget)\b[^|]*\|\s*(sudo\s+)?(sh|bash|zsh|powershell|pwsh)\b/i, reason: "下载即执行（curl | bash）" },
  { id: "base64-pipe-shell", level: "high", pattern: /\bbase64\b[^|]*-d[^|]*\|\s*(sh|bash|zsh)\b/i, reason: "解码即执行" },
  { id: "eval-base64", level: "high", pattern: /\beval\s+["'`]?\$\(.*base64/i, reason: "eval 解码执行" },
  { id: "fork-bomb", level: "high", pattern: /:\s*\(\s*\)\s*\{.*:\s*\|\s*:/, reason: "fork 炸弹" },
  { id: "iptables-flush", level: "medium", argv0: "iptables", any: ["-F"], reason: "清空防火墙规则" },
  { id: "reg-delete", level: "medium", argv0: "reg", all: ["delete"], reason: "删除注册表项" },
  { id: "takeown", level: "medium", argv0: "takeown", reason: "夺取文件所有权" },
  { id: "icacls", level: "medium", argv0: "icacls", reason: "修改文件权限" },
  { id: "ssh-keygen-overwrite", level: "medium", pattern: /\bssh-keygen\b[^&|;]*-f\s+\S+/, reason: "可能覆盖 SSH 私钥" },
  { id: "git-push-tags-force", level: "high", pattern: /\bgit\s+push\b[^&|;]*--tags[^&|;]*--force/, reason: "强推标签" },
];

/**
 * 把一条命令切成**段**（`;` `&&` `||` `|` 与换行都算分隔）。
 *
 * 引号里的分隔符不算 —— 否则 `echo "a; rm -rf /"` 会被当成两条命令（那是误报，
 * 而这种误报会让用户很快学会无视提示）。
 *
 * @param command 命令原文
 * @returns 段列表；引号不闭合时返回 null（调用方按高风险处理）
 */
export function splitSegments(command: string): string[] | null {
  const segments: string[] = [];
  let current = "";
  let quote: '"' | "'" | "`" | null = null;
  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i]!;
    if (quote) {
      current += ch;
      if (ch === "\\" && quote !== "'") {
        const next = command[i + 1];
        if (next !== undefined) {
          current += next;
          i += 1;
        }
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === ";" || ch === "\n") {
      if (current.trim()) segments.push(current.trim());
      current = "";
      continue;
    }
    if (ch === "&" || ch === "|") {
      /* `&&` / `||` 一次吃掉两个；单个 `&` 是后台执行，也当分隔 */
      const next = command[i + 1];
      if (next === ch) i += 1;
      if (current.trim()) segments.push(current.trim());
      current = "";
      continue;
    }
    current += ch;
  }
  if (quote) return null;
  if (current.trim()) segments.push(current.trim());
  return segments;
}

/**
 * 把一段命令切成词（去引号、保留参数里的空格）。
 *
 * @param segment 一段命令
 */
export function tokenize(segment: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  let started = false;
  for (let i = 0; i < segment.length; i += 1) {
    const ch = segment[i]!;
    if (quote) {
      if (ch === quote) {
        quote = null;
        continue;
      }
      current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      started = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (started || current) {
        tokens.push(current);
        current = "";
        started = false;
      }
      continue;
    }
    started = true;
    current += ch;
  }
  if (started || current) tokens.push(current);
  return tokens;
}

/** 一条词序列像不像"命令本身"（跳过 `sudo` / `env VAR=…` 这类前缀）。 */
function commandIndexOf(tokens: readonly string[]): number {
  let i = 0;
  while (i < tokens.length) {
    const t = tokens[i]!;
    if (t === "sudo" || t === "doas" || t === "time" || t === "nohup" || t === "command") {
      i += 1;
      continue;
    }
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(t)) {
      i += 1;
      continue;
    }
    break;
  }
  return Math.min(i, tokens.length);
}

/** 判断一条规则是否命中这一段的词与整条命令原文。 */
function hits(rule: Rule, tokens: readonly string[], raw: string, whole: string): boolean {
  const start = commandIndexOf(tokens);
  const argv0 = (tokens[start] ?? "").toLowerCase();
  if (rule.argv0 && argv0 !== rule.argv0) return false;
  /*
   * 管道类规则要对着**整条命令**测：`curl … | bash` 在分词时被切成两段，
   * 只看单段的话永远看不到那个 `|`。命令类（argv0）规则仍然看段。
   */
  if (rule.pattern) return rule.pattern.test(whole) || rule.pattern.test(raw);
  const lower = tokens.map((t) => t.toLowerCase());
  if (rule.all && !rule.all.every((word) => lower.includes(word))) return false;
  if (rule.any && !rule.any.some((word) => lower.includes(word))) return false;
  return true;
}

/**
 * 分析一条命令。
 *
 * @param command 命令原文
 * @param opts 覆盖规则表（测试用；省略 = 内置表）
 */
export function assessCommand(command: string, opts: { rules?: readonly Rule[] } = {}): CommandAssessment {
  const rules = opts.rules ?? RULES;
  const segments = splitSegments(command);
  if (segments === null) {
    return { level: "high", reasons: ["命令无法解析（引号没有闭合）—— 按高风险处理"], parsed: false };
  }
  if (segments.length === 0) {
    return { level: "medium", reasons: ["空命令"], parsed: true };
  }

  let level: CommandRisk = "low";
  const reasons: string[] = [];
  const rank: Record<CommandRisk, number> = { low: 0, medium: 1, high: 2 };
  for (const segment of segments) {
    const tokens = tokenize(segment);
    for (const rule of rules) {
      if (!hits(rule, tokens, segment, command)) continue;
      if (rank[rule.level] > rank[level]) level = rule.level;
      if (!reasons.includes(rule.reason)) reasons.push(rule.reason);
    }
  }
  return { level, reasons, parsed: true };
}

/** 给审批卡片/留痕用的一句话。 */
export function describeCommandRisk(assessment: CommandAssessment): string {
  const label = assessment.level === "high" ? "高风险" : assessment.level === "medium" ? "中等风险" : "低风险";
  if (!assessment.reasons.length) return `${label}命令`;
  return `${label}：${assessment.reasons.join("；")}`;
}
