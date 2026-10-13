import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { stepCountIs, streamText, type ToolSet } from "ai";
import type { SubagentBlocked, SubagentReport } from "../../shared/agentTools";
import { resolveSecret } from "./credentials";
import { getProvider } from "./aiProviders";

/**
 * 子智能体（§150）。
 *
 * ## 它是什么
 *
 * 一个**有自己一份上下文**的独立工作单元：父级把一件自包含的事交给它，
 * 它自己用工具办完，**只回一份要点报告**（不是它整段对话）。
 *
 * 依据 cline 的 `spawn_agent`；四件必须做对的事：
 *
 * | 要求 | 这一版怎么落 |
 * |---|---|
 * | 独立上下文 | 自己的 `messages`（只有任务与背景，看不到父对话） |
 * | 汇合并行 | 每个子智能体各跑各的，父级拿到的是它那份**摘要** |
 * | **成本上卷** | 把 token 用量回给父级，留痕里写出来（`describeToolResult`） |
 * | **审批穿透** | 子智能体拿的是**同一张闸门表**（同一个 `mode`）—— 它绕不过去 |
 *
 * ## 审批穿透具体是什么样
 *
 * 子智能体里的工具同样过闸门：`ask` 档下**不执行**，回一条"要看用户确认"。
 * 于是它能自由做只读的事，而**凡是会改东西的动作都办不成**，
 * 但**会如实写进报告**（`blocked`）—— 父级与用户都看得见"它想做但没被批准"。
 *
 * ⚠️ v1 的取舍（如实）：**子智能体里的 `ask` 没有"当场点允许"的按钮** ——
 * 那些动作要由父级（或用户）另起一次调用才会出现确认按钮。
 * 这比"子智能体静默地绕过了闸门"好得多：**宁可办不成，不能不问就办**。
 */

/** 搭一个与主请求同一 provider 的客户端（key 不出主进程）。 */
function makeClient(providerId: string): { client: ReturnType<typeof createOpenAICompatible>; model: string } | null {
  const provider = getProvider(providerId);
  if (!provider) return null;
  const apiKey = resolveSecret(provider.keyRef);
  if (!apiKey) return null;
  const client = createOpenAICompatible({ name: provider.id, baseURL: provider.baseURL, apiKey });
  return { client, model: provider.models[0] ?? "" };
}

/**
 * 跑一个子智能体。
 *
 * @param input.task 自包含的任务说明
 * @param input.context 背景材料
 * @param input.provider 主请求用的 provider（沿用同一个，不另配渠道）
 * @param input.model 主请求用的模型
 * @param input.system 子智能体的系统提示词（`subagentPrompt` 生成，由调用方传进来）
 * @param input.user 子智能体的用户消息
 * @param input.tools **已经按同一个闸门档位建好的**工具集
 * @param input.maxSteps 最多几步（默认 6）
 * @returns 要点报告
 */
export async function runSubagent(input: {
  provider: string;
  model?: string;
  system: string;
  user: string;
  tools: ToolSet;
  maxSteps?: number;
}): Promise<SubagentReport> {
  const made = makeClient(input.provider);
  if (!made) {
    return { ok: false, summary: "", steps: 0, toolCalls: [], blocked: [], error: "子智能体拿不到可用的 provider" };
  }
  const { client, model } = made;

  const toolCalls: string[] = [];
  /**
   * 被闸门拦下的调用（§176 起**结构化**：工具名 + 参数都留下）。
   *
   * 只存一行显示文字是不够的 —— 父级拿到它就**没有让它办成的办法**
   * （没有工具名与参数，谁都执行不了）。结构化之后父级能把它挂成自己的待批准项。
   */
  const blocked: SubagentBlocked[] = [];
  let text = "";
  /** 每步结束会来一个 `finish`，据此数步（拿不到就用工具调用数兜底）。 */
  let finishes = 0;
  /**
   * 步数（**在 try 之前定义**：catch 那支也要用它报"跑了几步就崩了"）。
   * 优先用 finish 计数；拿不到就按"工具调用数 + 1"兜底（至少有一轮）。
   */
  const stepCount = (): number => Math.max(finishes, toolCalls.length + 1);

  try {
    const result = streamText({
      model: client(input.model && model ? input.model : model),
      system: input.system,
      messages: [{ role: "user", content: input.user }],
      tools: input.tools,
      /*
       * 步数比父级（4）宽一点：子智能体拿到的是一件完整的活，
       * 往往要"查一次 → 看到结果 → 再查一次"。但也不放大 ——
       * 超过 10~20 轮就烂（12-factor 那句）。
       */
      stopWhen: stepCountIs(input.maxSteps ?? 6),
    });

    for await (const part of result.fullStream) {
      if (part.type === "text-delta") text += part.text;
      if (part.type === "tool-call") toolCalls.push(part.toolName);
      if (part.type === "tool-result") {
        /*
         * 被闸门拦下的那些：**没执行**（口径同 §143）。
         * 记进报告，别让它看起来像办成了。
         */
        const out = part.output as { pending?: boolean } | undefined;
        if (out?.pending) {
          blocked.push({
            toolCallId: part.toolCallId,
            name: part.toolName,
            ...(part.input === undefined ? {} : { input: part.input }),
          });
        }
      }
      if (part.type === "finish") finishes += 1;
    }

    const usage = await result.usage;
    const summary = text.trim();
    if (!summary) {
      return { ok: false, summary: "", steps: stepCount(), toolCalls, blocked, error: "子智能体没有给出报告" };
    }
    return {
      ok: true,
      summary,
      steps: stepCount(),
      toolCalls,
      blocked,
      usage: { inputTokens: usage?.inputTokens, outputTokens: usage?.outputTokens },
    };
  } catch (error) {
    return {
      ok: false,
      summary: "",
      steps: stepCount(),
      toolCalls,
      blocked,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
