/**
 * **IM 审批卡**（G12，2026-10-18）。
 *
 * ## 它解决什么
 *
 * 桌面上弹一个"允许 / 拒绝"当然好，但用户可能不在电脑前。手机上的飞书/Slack
 * 回一句 `yes a3f2` 就能放行 —— 这是"长任务可以托付"的最后一环。
 *
 * ## 四条口径（方案 §6.3 G12）
 *
 * 1. **短 ID**：每次待决发一个 4 位码（`a3f2`），手机上打得出、看得清；
 * 2. **`yes <码>` / `no <码>`**：只认这个形状（自然语言里说"好的"不算 —— 不能靠猜）；
 * 3. **超时**：默认 10 分钟，过期之后 `resolve` 返回"已过期"，不再生效；
 * 4. **first-come 四端**：同一条待决**只有第一个决定生效**；后到的返回"已经被谁批过了"
 *    —— 与桌面 `resolveTool` 的幂等守卫同一条语义。
 *
 * ## 为什么是纯逻辑
 *
 * "谁先批"与"过期"是**判定**，不该长在 HTTP 处理里；这里可单测，
 * `engine/im/server.ts` 只做搬砖。
 */

/** 一条待决（卡片上要显示的东西）。 */
export type PendingCard = {
  /** 短码（4 位小写字母数字） */
  code: string;
  sessionId: string;
  toolCallId: string;
  /** 工具名 */
  name: string;
  /** 参数摘要（**不含正文**；审批卡片只给"要干什么"） */
  summary: string;
  /** 过期时刻 */
  expiresAt: number;
  /** 发到哪个会话（飞书/Slack 的回信要用它） */
  chat: string;
  /** 平台 */
  platform: string;
};

/** 一次决定。 */
export type CardDecision = { ok: true; card: PendingCard; approved: boolean } | { ok: false; error: string };

/** 短码字母表（去掉容易看错的 0/o/1/l/i）。 */
const ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";

/**
 * 生成短码。
 *
 * @param random 随机源（测试可注入）
 */
export function makeCode(random: () => number = Math.random): string {
  let out = "";
  for (let i = 0; i < 4; i += 1) out += ALPHABET[Math.floor(random() * ALPHABET.length)] ?? "a";
  return out;
}

/**
 * 解析一句回复。
 *
 * 只认 `yes <码>` / `no <码>`（大小写不敏感；也接受 `y` / `n` / 中文「同意」「拒绝」）。
 *
 * @param text 用户回的那句
 * @returns 动作与码；不认识的形状给 null
 */
export function parseCardCommand(text: string): { approved: boolean; code: string } | null {
  const t = String(text ?? "").trim().toLowerCase();
  const m = /^(yes|y|同意|批准|no|n|拒绝|deny)\s+([a-z0-9]{4})$/.exec(t);
  if (!m) return null;
  const approved = ["yes", "y", "同意", "批准"].includes(m[1]!);
  return { approved, code: m[2]! };
}

/** 待决登记处。 */
export type CardRegistry = {
  /** 登记一条待决，给一个短码（同一条 toolCallId 重复登记返回已有的）。 */
  add(input: Omit<PendingCard, "code" | "expiresAt"> & { ttlMs?: number }): PendingCard;
  /** 按码取（过期的会被清掉）。 */
  get(code: string): PendingCard | undefined;
  /** 当前所有未过期的待决。 */
  list(): PendingCard[];
  /** 做一个决定（**first-come**：第二次返回失败）。 */
  resolve(code: string, approved: boolean, by: string): CardDecision;
  /** 清掉过期的（返回清了几条）。 */
  sweep(): number;
};

/** 默认有效期：10 分钟（与权限规则 TTL 同一口径）。 */
export const CARD_TTL_MS = 10 * 60 * 1000;

/**
 * 建一个登记处。
 *
 * @param opts.now 现在（测试注入）
 * @param opts.random 随机源（测试注入）
 */
export function createCardRegistry(opts: { now?: () => number; random?: () => number } = {}): CardRegistry {
  const now = opts.now ?? Date.now;
  const random = opts.random ?? Math.random;
  /** 码 → 待决。 */
  const byCode = new Map<string, PendingCard>();
  /** 已决定的码 → 谁决定的（first-come 的凭据）。 */
  const decided = new Map<string, { approved: boolean; by: string }>();

  const fresh = (card: PendingCard): boolean => card.expiresAt > now();

  const registry: CardRegistry = {
    add(input) {
      const existing = [...byCode.values()].find(
        (c) => c.sessionId === input.sessionId && c.toolCallId === input.toolCallId && fresh(c),
      );
      if (existing) return existing;
      let code = makeCode(random);
      /* 码空间只有 ~46 万，撞了就再取（最多试 20 次；仍撞就报错比死循环好） */
      for (let i = 0; i < 20 && byCode.has(code); i += 1) code = makeCode(random);
      const card: PendingCard = {
        ...input,
        code,
        expiresAt: now() + (input.ttlMs ?? CARD_TTL_MS),
      };
      byCode.set(code, card);
      return card;
    },

    get(code) {
      const card = byCode.get(String(code ?? "").toLowerCase());
      if (!card) return undefined;
      if (!fresh(card)) {
        byCode.delete(card.code);
        return undefined;
      }
      return card;
    },

    list() {
      registry.sweep();
      return [...byCode.values()];
    },

    resolve(code, approved, by) {
      const key = String(code ?? "").toLowerCase();
      const card = registry.get(key);
      if (!card) {
        const prior = decided.get(key);
        if (prior) return { ok: false, error: `这条已经被 ${prior.by} ${prior.approved ? "批准" : "拒绝"}过了` };
        return { ok: false, error: `没有这个码或已经过期：${key}` };
      }
      /*
       * first-come：**先写 decided 再删** —— 两个并发请求同时进来时，
       * 只有一个能过 `!decided.has` 这道判据（Node 单线程下这里是原子的）。
       */
      if (decided.has(key)) return { ok: false, error: `这条已经被 ${decided.get(key)!.by} 处理过了` };
      decided.set(key, { approved, by });
      byCode.delete(key);
      return { ok: true, card, approved };
    },

    sweep() {
      let n = 0;
      for (const [code, card] of byCode) {
        if (!fresh(card)) {
          byCode.delete(code);
          decided.set(code, { approved: false, by: "（超时）" });
          n += 1;
        }
      }
      return n;
    },
  };
  return registry;
}

/**
 * 审批卡片的文字（飞书/Slack 共用一份：两边都支持纯文本消息）。
 *
 * @param card 待决
 * @param opts.now 现在（算还剩多久）
 */
export function cardText(card: PendingCard, opts: { now?: number } = {}): string {
  const now = opts.now ?? Date.now();
  const left = Math.max(0, Math.round((card.expiresAt - now) / 1000));
  return [
    `【需要你批准】${card.name}`,
    card.summary ? `要做什么：${card.summary}` : "",
    `回 \`yes ${card.code}\` 允许，或 \`no ${card.code}\` 拒绝。`,
    `（${left} 秒内有效；过期就不再执行）`,
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * 飞书消息卡片的结构（交互式卡片 v1 的最小形状）。
 *
 * @param card 待决
 * @param opts.now 现在
 */
export function feishuCard(card: PendingCard, opts: { now?: number } = {}): Record<string, unknown> {
  return {
    msg_type: "interactive",
    card: {
      config: { wide_screen_mode: true },
      elements: [
        { tag: "div", text: { tag: "lark_md", content: cardText(card, opts) } },
      ],
      header: { template: "orange", title: { tag: "plain_text", content: "需要你批准" } },
    },
  };
}

/**
 * Slack Block Kit 的最小形状。
 *
 * @param card 待决
 * @param opts.now 现在
 */
export function slackBlocks(card: PendingCard, opts: { now?: number } = {}): Record<string, unknown> {
  return {
    text: `需要你批准：${card.name}`,
    blocks: [
      { type: "section", text: { type: "mrkdwn", text: cardText(card, opts) } },
    ],
  };
}
