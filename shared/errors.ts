/**
 * 说人话的**单一来源**（Phase 13.1）。
 *
 * ## 为什么要有这个文件
 *
 * 在这之前，"把上游错误翻成人话"这件事**长了两份**：
 *
 * | 通道 | 实现 | 429 时说的话 |
 * |---|---|---|
 * | 文本对话 | `engine/runtime/loop.ts` 的 `humanError` | 「触发限流，稍后重试」 |
 * | 图像生成 | `src/ai/imageClient.ts` 的 `humanImageError` | 「被限流或额度用完了：…」 |
 *
 * 同一个原因、用户看到两句不同的话 —— 这正是方案 13.1 要收掉的东西
 * （"错误/拦截/限额文案单一来源"）。而且两份实现各有各的漏项：
 * 图像侧认得「欠费」「审核」，文本侧不认；文本侧认得 `ENOTFOUND`，图像侧不认。
 *
 * ## 收口的口径：**只留"原因 → 一句话"，不留"哪个通道"**
 *
 * 所以这里的每个分支都只描述**发生了什么**，不描述"是谁在调"。通道差异（要不要带上原文）
 * 由调用方决定 —— 图像那条要保留上游原文（用户要拿它去投诉/查账），文本那条不要
 * （那是协议细节，用户看不懂）。
 *
 * ## 三条写作规矩（`copy.test.ts` 会验）
 *
 * 1. **每条都给出下一步**（"稍后重试" / "检查密钥" / "换个模型"）——
 *    只说"出错了"等于把问题丢回给用户；
 * 2. **不许出现裸状态码**（429 / 502 / ECONNREFUSED 这类）——
 *    它们对用户没有信息量，要翻译成"限流 / 上游不可用 / 连不上"；
 * 3. **拦截类文案必须说明"还没有执行"** —— 用户最需要知道的是"我的东西没被动"。
 */

/** 归好类的失败原因（"是什么坏了"，与通道无关）。 */
export type FailureKind =
  | "aborted"
  | "auth" // 密钥无效 / 过期
  | "model" // 模型名不对 / 不存在
  | "rate" // 限流
  | "quota" // 余额 / 欠费 / 额度用完
  | "network" // 连不上 / 本地服务没起
  | "upstream" // 上游暂时不可用（502/503）
  | "moderation" // 内容审核没过
  | "timeout"
  | "unknown";

/**
 * 从一段上游错误里认出**原因**。
 *
 * ⚠️ 判定顺序有关系：「欠费」优先于「限流」——欠费时上游也常回 429，
 * 但正确的下一步是"充值"而不是"稍后重试"。先后次序就是这里的语义。
 *
 * @param raw 上游给的原始文本（或整条错误消息）
 * @returns 归好的类别
 */
export function classifyFailure(raw: string): FailureKind {
  if (/abort/i.test(raw)) return "aborted";
  // 欠费**优先于**限流：两者都可能回 429，但下一步完全不同
  if (/insufficient|balance|quota|arrearage|overdue|good standing|欠费|余额不足|额度/i.test(raw)) return "quota";
  if (/401|403|unauthorized|invalid api key|api key/i.test(raw)) return "auth";
  if (/404|model.*not.*found|no such model/i.test(raw)) return "model";
  if (/429|rate limit|too many requests|限流/i.test(raw)) return "rate";
  if (/moderation|content|policy|safety|审核/i.test(raw)) return "moderation";
  if (/timeout|timed out|超时/i.test(raw)) return "timeout";
  if (/502|503|504|unavailable|bad gateway|上游暂时/i.test(raw)) return "upstream";
  if (/ENOTFOUND|ECONNREFUSED|ECONNRESET|fetch failed|network|连不上|socket/i.test(raw)) return "network";
  return "unknown";
}

/**
 * 原因 → 给人看的一句话（**不带上游原文**）。
 *
 * 通道无关：图像、文本、CLI、桌面都用它。
 *
 * @param kind 原因
 * @returns 一句话（含下一步）
 */
export function failureMessage(kind: FailureKind): string {
  switch (kind) {
    case "aborted":
      return "已中止";
    case "auth":
      return "密钥无效或已过期（检查一下这个 provider 的 API key）";
    case "model":
      return "模型不存在（检查模型名与 provider 是否对得上）";
    case "rate":
      return "触发限流，稍后重试（或换一个模型档位）";
    case "quota":
      return "账户余额不足或额度已用完（充值或换一个 key 后重试）";
    case "network":
      return "连不上 provider（检查网络，或本地服务是否已启动）";
    case "upstream":
      return "上游服务暂时不可用，稍后重试";
    case "moderation":
      return "内容审核没通过（改一下措辞或去掉敏感内容后重试）";
    case "timeout":
      return "请求超时（生成可能还在排队，稍后重试）";
    default:
      return "";
  }
}

/**
 * 把一段上游错误翻成人话。
 *
 * @param raw 上游原文（或整条错误消息）
 * @param options.keepDetail 是否把上游原文附在后面（图像那条要：用户拿它查账/投诉）
 * @param options.fallbackLimit 认不出来时截多长（文本那条截到 200 字，别把 SDK 的堆栈糊到界面上）
 * @returns 给人看的一句话
 */
export function humanFailure(
  raw: string,
  options: { keepDetail?: boolean; fallbackLimit?: number } = {},
): string {
  const kind = classifyFailure(raw);
  const message = failureMessage(kind);
  if (!message) return raw.slice(0, options.fallbackLimit ?? 200);
  /*
   * `keepDetail` 的差别只在**附不附原文** —— 措辞本身两边一模一样（这就是收口的意义）。
   */
  return options.keepDetail ? `${message}：${raw}` : message;
}
