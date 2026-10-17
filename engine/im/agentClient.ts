/**
 * IM 桥 → Agent Server 的客户端（V6-2f）。
 *
 * 复用 V5-3.6 的 `/v1/channels/<渠道>`：一条消息进去，SSE 里 `done.reply` 出来。
 * 不另造一条"给 IM 用的"接口 —— 另造的那条一定会与本机对话漂（同一句问法两种行为）。
 */

export type AgentChannelOptions = {
  /** Agent Server 地址（`ding serve` 那台）。 */
  baseURL: string;
  /** 主口令 / 成员口令。 */
  token: string;
  /** 渠道名（`feishu` / `slack`；进会话 id，也进账本 end_user 那一层）。 */
  channel: string;
  /** 外面那个人（平台 user id）。 */
  from: string;
  text: string;
  fetchImpl?: typeof fetch;
  /** 整轮超时（默认 5 分钟；agent 跑长任务时别太短）。 */
  timeoutMs?: number;
};

/** 从 SSE 文本里找 `reply`（最后一个非空的）。 */
export function replyFromSse(text: string): string {
  let reply = "";
  for (const block of String(text ?? "").split(/\n\n/)) {
    const data = block
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim())
      .join("");
    if (!data) continue;
    try {
      const json = JSON.parse(data) as { reply?: unknown };
      if (typeof json.reply === "string" && json.reply.trim()) reply = json.reply.trim();
    } catch {
      /* 非 JSON 的 data 帧：跳过（SSE 里可能有注释/心跳） */
    }
  }
  return reply;
}

/**
 * 问一轮，拿回复正文。
 *
 * @returns 回复正文；SSE 里没有 reply 时返回空串（调用方会说"没有产出正文"）
 */
export async function askAgentViaChannel(opts: AgentChannelOptions): Promise<string> {
  const base = opts.baseURL.replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(base)) throw new Error(`agent 地址必须是 http(s)：${opts.baseURL}`);
  const doFetch = opts.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 300_000);
  try {
    const response = await doFetch(`${base}/v1/channels/${encodeURIComponent(opts.channel)}`, {
      method: "POST",
      headers: { authorization: `Bearer ${opts.token}`, "content-type": "application/json" },
      body: JSON.stringify({ from: opts.from, text: opts.text }),
      signal: controller.signal,
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`agent 返回 HTTP ${response.status}：${text.slice(0, 200)}`);
    return replyFromSse(text);
  } finally {
    clearTimeout(timer);
  }
}
