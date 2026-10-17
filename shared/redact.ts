/**
 * **密钥脱敏**（U14，2026-10-18）。
 *
 * ## 为什么需要它
 *
 * 项目的规矩是"日志/错误/导出里不许有 secret"，但这条规矩之前只落在
 * "别把 key 写进去"这一个动作上 —— 没有**拦截层**。而 secret 会从很多不经意的
 * 地方漏出来：上游错误原文（`humanFailure` 的 keepDetail 那条路）、
 * 用户贴的命令（`curl -H "Authorization: Bearer …"`）、诊断包里的配置原文。
 *
 * 这里给一个**兜底**：任何要落盘/展示给第三方的文本都过一遍它。
 * 它**不是**加密，也不假装能挡住所有形态 —— 只覆盖已知的、最常见的那几类。
 *
 * ## 覆盖的形态（每条都对着一种真实泄漏）
 *
 * | 形态 | 例子 |
 * |---|---|
 * | 常见前缀的 API key | `sk-…`、`sk-ant-…`、`ghp_…`、`xoxb-…` |
 * | 认证头 | `Authorization: Bearer eyJ…` |
 * | URL 查询参数 | `?api_key=…&token=…` |
 * | 键值对 | `api_key: "…"` / `"password": "…"` |
 *
 * ## 明确不做
 *
 * - 不猜"看起来像密钥"的随机串（会把正常 id 也打掉，反而没人敢用）；
 * - 不处理二进制 —— 那是调用方的事（别把二进制当文本读）。
 */

/** 掩码（保留前 4 位方便排查"是哪把 key"，其余全盖掉）。 */
function mask(value: string): string {
  const head = value.slice(0, Math.min(4, value.length));
  return `${head}…（已脱敏 ${value.length} 字符）`;
}

/** 一条规则：匹配整段可替换的密钥。 */
const RULES: ReadonlyArray<{ pattern: RegExp; replace: (m: RegExpMatchArray) => string }> = [
  /* 常见前缀的 key（OpenAI / Anthropic / GitHub / Slack / Google 等） */
  {
    pattern: /\b(sk-(?:ant-|proj-)?[A-Za-z0-9_-]{8,})\b/g,
    replace: (m) => mask(m[1]!),
  },
  { pattern: /\b(gh[pousr]_[A-Za-z0-9]{16,})\b/g, replace: (m) => mask(m[1]!) },
  { pattern: /\b(xox[baprs]-[A-Za-z0-9-]{10,})\b/g, replace: (m) => mask(m[1]!) },
  { pattern: /\b(AIza[0-9A-Za-z_-]{20,})\b/g, replace: (m) => mask(m[1]!) },
  /* Authorization: Bearer <token> / Basic <base64> */
  {
    pattern: /\b(Bearer\s+)([A-Za-z0-9._~+/=-]{8,})/gi,
    replace: (m) => `${m[1]}${mask(m[2]!)}`,
  },
  {
    pattern: /\b(Basic\s+)([A-Za-z0-9+/=]{12,})/gi,
    replace: (m) => `${m[1]}${mask(m[2]!)}`,
  },
  /* URL 查询参数：?api_key=… / &token=… / &access_token=… */
  {
    pattern: /([?&](?:api[_-]?key|token|access[_-]?token|key|secret)=)([^&\s"']+)/gi,
    replace: (m) => `${m[1]}${mask(m[2]!)}`,
  },
  /* 键值对：api_key: "…" / "password": "…" / client_secret=… */
  {
    pattern: /((?:api[_-]?key|access[_-]?key|secret|password|passwd|client[_-]?secret)["']?\s*[:=]\s*["']?)([^"'\s,}]{8,})/gi,
    replace: (m) => `${m[1]}${mask(m[2]!)}`,
  },
];

/**
 * 把一段文本里的已知密钥形态盖掉。
 *
 * @param text 任意文本（日志行、错误原文、诊断包 JSON）
 * @returns 脱敏后的文本（**长度会变**，不要拿它做逐字比对）
 */
export function redactSecrets(text: string): string {
  let out = String(text ?? "");
  for (const rule of RULES) out = out.replace(rule.pattern, (...args) => rule.replace(args as unknown as RegExpMatchArray));
  return out;
}

/** 递归脱敏一个可 JSON 化的值（诊断包用；不改原对象）。 */
export function redactDeep(value: unknown): unknown {
  if (typeof value === "string") return redactSecrets(value);
  if (Array.isArray(value)) return value.map((item) => redactDeep(item));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) out[key] = redactDeep(item);
    return out;
  }
  return value;
}
