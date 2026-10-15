import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * 评测用的**假 provider**（Phase 10.2 的"离线模式"）。
 *
 * ## 为什么是"回放"而不是"打真端点"
 *
 * 方案 10.2 要求评测**不烧 token、可进 CI**。做法与 `engine/runtime/loop.test.ts` 同一招：
 * 在回环上起一个 OpenAI 兼容的 SSE 服务，按用例脚本吐帧 —— 于是被测的仍是**真代码路径**
 * （真 SDK、真流解析、真工具往返、真闸门），只是模型那一段被换成了确定性的脚本。
 *
 * ## 用例作者写的是"回什么"，不是"吐哪几帧"
 *
 * 帧形状（`chat.completion.chunk`）是实现细节；用例里写的是**语义**：
 * 「回一句文本」或「调一个工具」。这样换 SDK 的时候用例不用重写。
 *
 * ## ⚠️ 必须无状态
 *
 * 这条是 `loop.test.ts` 用两次红换来的：用共享计数器选分支时，**跨用例会串**
 * （上一轮在步数上限处停下时，最后一次请求还在飞，会涨到下一个用例的计数器上）。
 * 所以这里的脚本**只看请求体自己**：
 *
 *   · 请求体里**没有**工具结果 → 这是这一轮的第一步 → 取 `reply[0]`
 *   · 有工具结果（`"role":"tool"`）→ 取下一个还没用过的 reply
 *
 * ## ⚠️ 子智能体的请求也在同一条服务上
 *
 * 团队 / 子智能体那几条用例里，**子智能体自己也会打这个假 provider**（它是一轮真的 agent 回合）。
 * 所以"第几个请求"不能直接拿来选脚本 —— 子级的请求会把计数带偏
 * （实测：`team-then-single` 因此少走一步）。
 *
 * 判据是**父级的请求里带着这条用例的用户原话**（子级只带它自己的任务说明，两者不同）：
 * 于是"这是父级的第几个请求"可以精确数出来，子级一律回一句收尾话。
 *
 * ## ⚠️ 而且要容忍"迟到请求"
 *
 * 一轮结束后可能还有在途请求。为了不把迟到请求的响应算进下一个用例，
 * 每个用例用**自己的服务实例**（`startFakeProvider` 每次新建），并在用例结束时关掉。
 * 关掉之后迟到的连接会失败，但那时这一轮已经结束了。
 */

/** 用例脚本里的一次"模型回复"。 */
export type EvalReply =
  /**
   * 只说一句话（收尾 = `stop`）。
   *
   * `chunks` 给"分多帧吐"的用例：真实模型是一个词一个词流出来的，
   * 而**一帧吐完**与**分十帧吐完**在客户端是两条不同的路径
   * （前者测不到增量归并）。不传 `chunks` 就是一帧。
   */
  | { say: string; chunks?: string[] }
  /** 调一个或多个工具（收尾 = `tool_calls`）。`say` 可选：先吐一句再调（也可分帧）。 */
  | { say?: string; chunks?: string[]; call: { name: string; args: Record<string, unknown> }[] }
  /**
   * **中途断开**（崩溃注入，Phase 10.6）：不回任何帧，直接把连接掐掉。
   * 用它验的是"上游半路没了"时这一轮**怎么收场** —— 该报错收尾，不该挂在那里等。
   */
  | { crash: true };

/** 一帧 chunk 的公共字段（与真 provider 同形）。 */
const CHUNK = { id: "eval-1", object: "chat.completion.chunk", created: 0, model: "eval-model" };

const textFrame = (t: string) => ({ ...CHUNK, choices: [{ index: 0, delta: { content: t }, finish_reason: null }] });
const finishFrame = (reason: string) => ({ ...CHUNK, choices: [{ index: 0, delta: {}, finish_reason: reason }] });
const usageFrame = (p: number, c: number) => ({
  ...CHUNK,
  choices: [],
  usage: { prompt_tokens: p, completion_tokens: c, total_tokens: p + c },
});
/** 工具调用帧：第一帧带 id/name，后续只带 arguments 片段（与真 provider 同形）。 */
const toolFrame = (id: string | null, name: string | null, args: string) => ({
  ...CHUNK,
  choices: [
    {
      index: 0,
      delta: { tool_calls: [{ index: 0, ...(id ? { id, type: "function" } : {}), function: { ...(name ? { name } : {}), arguments: args } }] },
      finish_reason: null,
    },
  ],
});

/** 把一次语义回复翻成一串帧。 */
function framesOf(reply: EvalReply, index: number): object[] {
  const out: object[] = [];
  if ("crash" in reply) return out;
  if ("say" in reply && reply.say) {
    // `chunks` 给了就按它分帧（否则整段一帧）—— 分帧要拼起来仍等于 `say`
    const pieces = reply.chunks?.length ? reply.chunks : [reply.say];
    for (const piece of pieces) out.push(textFrame(piece));
  }
  if ("call" in reply && reply.call?.length) {
    reply.call.forEach((c, i) => {
      const id = `call_${index}_${i}`;
      out.push(toolFrame(id, c.name, JSON.stringify(c.args)));
    });
    out.push(finishFrame("tool_calls"));
  } else {
    out.push(finishFrame("stop"));
  }
  // 用量放在收尾之后（真 provider 也是单独一帧，choices 为空）
  out.push(usageFrame(100 + index * 10, 20 + index));
  return out;
}

export type FakeProvider = {
  /** 指到它用：`STRATA_BASE_URL = provider.url`。 */
  url: string;
  /** 收到过的请求体（按到达顺序）—— 断言"下发了哪些工具"用它。 */
  bodies: unknown[];
  /** 停掉（每用例一个实例，用完就关）。 */
  close: () => Promise<void>;
};

/**
 * 起一个假 provider。
 *
 * @param replies 这一轮的脚本：第一步取 `replies[0]`，之后按"已用次数"递进。
 *   用完就**重复最后一条**（而不是报错）—— 否则用例跑到步数上限时，
 *   假 provider 会先炸，把"产品行为"掩盖成"测试装置行为"。
 * @returns 见 `FakeProvider`
 */
export async function startFakeProvider(replies: readonly EvalReply[], parentTurns: readonly string[] = []): Promise<FakeProvider> {
  const bodies: unknown[] = [];
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let raw = "";
    req.on("data", (d: Buffer | string) => {
      raw += String(d);
    });
    req.on("end", () => {
      let parsed: unknown = null;
      try {
        parsed = JSON.parse(raw);
      } catch {
        /* 请求体不合法也照吐，这一层测的不是它 */
      }
      bodies.push(parsed);

      /*
       * 选哪一条脚本。
       *
       * ⚠️ 第一版按"有几次工具结果"算，于是**多轮用例全乱**：没有工具的两轮对话里
       * 那个计数恒为 0，第二轮拿到的是第一轮那一条（`chat-two-turns` 因此红）。
       * 第二版按"本实例第几个请求"算，又**被子智能体带偏**：子级也打这个服务
       * （`team-then-single` 因此少走一步）。
       *
       * 现在：**只有"带着这条用例用户原话"的请求才算父级的** ——
       * 子级的消息里只有它自己的任务说明，两者不会混。
       */
      const isParent = parentTurns.length > 0 && parentTurns.some((t) => JSON.stringify(parsed ?? "").includes(t));
      const parentSoFar = bodies.filter((b) => parentTurns.some((t) => JSON.stringify(b ?? "").includes(t))).length;
      const index = Math.max(0, Math.min(parentSoFar - 1, replies.length - 1));
      const reply = isParent ? (replies[index] ?? { say: "" }) : { say: "（子智能体收尾）" };

      if ("crash" in reply && reply.crash) {
        // 崩溃注入（Phase 10.6）：连响应头都不回，直接把连接掐掉
        // —— 模拟上游进程被杀 / 网络断在半路。验的是"这一轮怎么收场"，不是"会不会崩"。
        req.socket.destroy();
        return;
      }

      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      for (const frame of framesOf(reply, index)) res.write(`data: ${JSON.stringify(frame)}\n\n`);
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}/v1`,
    bodies,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
