/**
 * IM 身份接入的类型（V6-2f）。
 *
 * 与 V5-3.6 的"渠道触发器"不同：那一层是**外面有个桥**（Telegram bot / 自建脚本）
 * 把消息翻成 HTTP；这一层是 Ding **自己以 bot 身份**接平台 webhook 并回复。
 *
 * 三种身份仍然分开（与渠道那条一致）：
 * | 层 | 谁 |
 * |---|---|
 * | user | bot 自己（平台应用凭据） |
 * | end_user | 发消息的人（平台 user id） |
 * | account | 会话归属（走 `/v1/channels/<渠道>` 那条路的 owner） |
 */

export type ImPlatform = "feishu" | "slack";

/** 一条进站消息（平台差异已经抹平）。 */
export type IncomingMessage = {
  platform: ImPlatform;
  /** 平台事件 id（去重键）。 */
  eventId: string;
  /** 发消息的人（平台 user id）。 */
  userId: string;
  /** 回到哪个会话（群/频道 id）。 */
  chatId: string;
  /** 正文（@ 机器人那些标记已剥掉）。 */
  text: string;
};

/** 平台的回复能力（抽象出来，测试能换假的）。 */
export type ImReplier = (message: IncomingMessage, reply: string) => Promise<{ ok: boolean; error?: string }>;

/** 处理一条消息的依赖。 */
export type ImHandlerDeps = {
  /** 把消息交给 agent（返回回复正文）。 */
  askAgent: (message: IncomingMessage) => Promise<string>;
  /** 平台侧回复。 */
  reply: ImReplier;
  /** 去重（同一条事件重复投递只处理一次）。 */
  seen: { has: (eventId: string) => boolean; add: (eventId: string) => void };
  log?: (line: string) => void;
  /**
   * 回复之后再做一件事（G12：查这一轮的待批并发审批卡）。
   *
   * 单独一个钩子而不是塞进 `reply`：回复的语义是"把 agent 这轮的话送回去"，
   * 卡片是**另一条消息**（另一个事件 id），混在一起会让"回复失败"与"发卡失败"
   * 分不清。钩子抛错只记日志，不影响已经发出的回复。
   */
  afterReply?: (message: IncomingMessage) => Promise<void>;
};

/**
 * 处理一条进站消息：去重 → 问 agent → 回复。
 *
 * 返回 `"duplicate"` 时**不回复**（平台重投时重复回一遍比漏回更烦人）。
 *
 * @param message 消息
 * @param deps 依赖
 */
export async function handleIncoming(message: IncomingMessage, deps: ImHandlerDeps): Promise<"replied" | "duplicate" | "empty"> {
  const log = deps.log ?? (() => undefined);
  if (!message.eventId) {
    log("没有 eventId，无法去重（跳过）");
    return "duplicate";
  }
  if (deps.seen.has(message.eventId)) {
    log(`重复投递：${message.eventId}（跳过）`);
    return "duplicate";
  }
  /* 先记再处理：平台重投时哪怕上一轮还在跑，也不该再启一轮 */
  deps.seen.add(message.eventId);

  const text = message.text.trim();
  if (!text) {
    log("空消息（跳过）");
    return "empty";
  }

  let answer: string;
  try {
    answer = (await deps.askAgent({ ...message, text })).trim();
  } catch (error) {
    answer = `我这轮没跑完：${String((error as Error)?.message ?? error).slice(0, 200)}`;
  }
  if (!answer) answer = "（这一轮没有产出正文）";

  const got = await deps.reply(message, answer);
  if (!got.ok) log(`回复失败：${got.error ?? "未知原因"}`);
  /*
   * 回复之后的钩子（G12 发审批卡）：**失败只记日志** —— 回复已经送出去了，
   * 卡片没发成不该把这一轮说成失败（用户会收到重复回复或以为整轮没跑）。
   */
  if (deps.afterReply) {
    try {
      await deps.afterReply({ ...message, text });
    } catch (error) {
      log(`回复后的动作失败：${String((error as Error)?.message ?? error).slice(0, 200)}`);
    }
  }
  return "replied";
}
