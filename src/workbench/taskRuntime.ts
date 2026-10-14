/**
 * 任务运行时（C6-4 Step 3）：一条任务从「发出去」到「落成一步」的全部逻辑。
 *
 * ## 这里装的是什么
 *
 * 起标题（`refineTitle`）、上下文压缩（`enabledBlock` / `compactKeepTokens` / `summaryFor`）、
 * 跑一次流（`runStream`）、把模型输出落成一步（`answerTurn` / `nextStep`）、
 * 产物落盘（`persistArtifacts`）、中止（`abortRunning`）。
 * 它们原来长在 `store.ts` 里（1296 行那个巨石），整块搬过来，**逻辑一个字没动**。
 *
 * ## 为什么搬得动（环怎么破）
 *
 * 这些函数要读/写工作台 store（`tasks` / `runningRequestId`），而 store 的 action 又要调它们 ——
 * 直接静态互引就是双向 import。这里按本仓已有的手法（`scheduleStore.execute(id, get, set)`）
 * **把 store 的读写当参数传进来**：本文件对 store **只有 `import type`**（编译后完全擦除），
 * 运行期能力由 `StorePort` 注入。于是依赖单向 `store.ts → taskRuntime.ts → task.ts`，
 * 环在结构上不可能成立 —— 不是靠"约定别成环"。
 *
 * ## 状态只有一个家
 *
 * `activeHandle` / `calibrationFactor` / `lastRequestEstimate` / `summaryCache` 是**本模块**的
 * 模块级状态（跟着这段逻辑一起搬过来）。别在 store.ts 或别处再声明一份 —— 两份的形状一样、
 * 坏法很具体：中止静默失效、校准系数永不更新。
 */
import type { ChatMessage, ShellBridge } from "@shared/ipc";
import { streamChat, completeOnce } from "../ai/aiClient";
import { buildFollowUpPrompt, parseAskReply } from "./agent";
import { artifactFileName, extractArtifacts, type Artifact } from "./artifact";
import { enabledPromptBlock } from "@shared/library";
import { fallbackNote } from "@shared/settings";
import { toolLabel, type ToolTrace } from "@shared/agentTools";
import { applyEvent, emptyTurn, finishTurn } from "@engine/core/events";
import { assembleSystem } from "@engine/core/assembly";
import { fabricatedCost, type StepUsage } from "@shared/cost";
import { calibrationOf, estimateTokens, totalTokens } from "@engine/core/context";
import { buildHistory } from "./history";
import { agentPromptBlock } from "./agentStore";
import { memoryPromptBlock } from "@shared/memory";
import { useMemoryStore } from "./memoryStore";
import { resolveChatRoute } from "@/ai/route";
import {
  KEEP_TOKENS,
  compactedNote,
  compactPrompt,
  shouldCompact,
  signatureOf,
  planContext,
  withSummary,
} from "./compaction";
import { readConfirmMode } from "./confirmMode";
import {
  acceptQuestions,
  cleanTitle,
  current,
  makeStepId,
  upsertTask,
  type TaskStep,
  type WorkTask,
} from "./task";
/** ⚠️ 只是类型：编译后没有这条 import —— 这正是"环不成环"的关键。 */
import type { StorePort } from "./store";

/*
 * ── 真实用量校准（补完④）────────────────────────────────────────
 *
 * provider 每轮给 `usage.inputTokens`（真值），我们对"这一轮发出去的东西"也有个估算
 * （system + messages）。两者一比就是系数，**下一轮**用它把额度换算到估算单位
 * （见 `shared/contextWindow.ts` 的 `calibrationOf`）。
 *
 * ⚠️ 只放内存：系数是"这台机器 + 这个 provider"的当期口径，重启后重新学即可 ——
 * 落盘反而要担心"换了模型还在用旧系数"。
 */
/** 当前这条流（补完⑤）：中止要调它的本地 `abort()`，否则这一步永远不落盘。 */
let activeHandle: { abort: () => void } | null = null;

let calibrationFactor = 1;
/** 上一轮"发出去的东西"的估算量（收尾时与真实 usage 一起算系数）。 */
let lastRequestEstimate = 0;

/**
 * 让模型给任务起标题（对标上位 `moa_comms_taskTitleLimit` =「任务标题，不超过16个字。」）。
 *
 * 起名失败**不报错也不打断**：本地启发式那份标题还在，用户看不到任何异常。
 * 但要把结果**清洗**一遍 —— 模型常常带引号、书名号、句号，
 * 或者干脆回一句「好的，标题是…」，直接塞进列表会很难看。
 *
 * @param taskId 任务 id
 * @param brief 用户原话
 */
export async function refineTitle(port: StorePort, taskId: string, brief: string): Promise<void> {
  const route = await resolveRoute();
  if (!route.provider) return;

  let acc = "";
  try {
    const handle = await streamChat(
      {
        provider: route.provider,
        model: route.model,
        messages: [{ role: "user", content: brief }],
        system: [
          "给这个任务起一个标题。",
          "要求：不超过 16 个字；只输出标题本身，不要引号、不要标点结尾、不要任何解释。",
        ].join("\n"),
      },
      (event) => {
        if (event.type === "text") acc += event.text;
      },
    );
    await handle.done;
  } catch {
    return; // 起名是锦上添花，失败就当没发生
  }

  const title = cleanTitle(acc);
  if (!title) return;
  port.setState((s) => ({
    tasks: s.tasks.map((t) => (t.id === taskId ? { ...t, title } : t)),
  }));
}


/**
 * 解析本次要用的 provider / model。
 *
 * 优先读聊天那边保存的设置；**读不到就现场挑一个可用的** ——
 * 否则会把空字符串发给主进程，得到 `未知 provider:` 这种没头没脑的报错
 * （实测踩过：全新的用户数据目录里没有这条设置，任务直接秒失败）。
 *
 * 挑选顺序跟聊天侧栏一致：优先已验证可用的，其次只是有密钥的。
 */
/**
 * 解析路由 —— 实现搬去 `src/ai/route.ts` 了（§153 抽成共用件，
 * 免得 AI 文档那条路自己写一份、出现"对话能用、润色说没通道"的自相矛盾）。
 */
const resolveRoute = resolveChatRoute;


/**
 * 取"本次启用能力"的提示词片段（阶段 11.7）。
 *
 * 上位把启用项走 `extraExt.input_skill = JSON.stringify({skill_id, skill_type})`
 * 交给服务端，由**服务端**注入这些能力的 schema。单机版没有那一层，
 * 所以退化成"在系统提示词里说清这次可以用什么" —— 这是**有意降级**：
 * 模型至少知道该用什么，而不是完全不知道。
 *
 * @returns 系统提示词片段；没有启用项时返回空串
 */
async function enabledBlock(): Promise<string> {
  try {
    const { useLibraryStore, findItemIn } = await import("./libraryStore");
    const lib = useLibraryStore.getState().lib;
    // 用 findItemIn 而不是 findItem：自定义能力不在内置目录里，
    // 只查目录会让它们进了 enabled 也拿不到名字 —— 等于装了没用。
    return enabledPromptBlock(lib, (id) => findItemIn(lib, id));
  } catch {
    return "";
  }
}

/**
 * 保留额度（§149）。
 *
 * 正常就是 `KEEP_TOKENS = 20000`。**本地存储里那个键是给验收用的开关** ——
 * 不然要验证"压了之后还能答对"，得先造一段两万 token 的真实对话（十几次模型调用）。
 * 界面上没有入口，生产不会有人设它。
 *
 * 读不到 / 读到乱值就回落默认值：这个值只影响"什么时候压"，不该让请求失败。
 */
function compactKeepTokens(): number {
  try {
    const raw = Number(localStorage.getItem("dsh-canvas.compact-keep-tokens"));
    return Number.isFinite(raw) && raw > 0 ? raw : KEEP_TOKENS;
  } catch {
    return KEEP_TOKENS;
  }
}

/**
 * 摘要缓存（§149）：同一个任务、**同一批要压的消息**就复用上次的摘要。
 *
 * 不缓存的话每一次追问都会多花一次压缩调用 —— 用户问三句就白花三次。
 */
const summaryCache = new Map<string, { sig: string; summary: string }>();

/**
 * 把更早那批对话压成要点。
 *
 * @param taskId 哪个任务（缓存的键）
 * @param older 要压的消息（旧 → 新）
 * @returns 摘要文本；**失败返回空串**（调用方据此降级成"发完整历史"）
 */
async function summaryFor(taskId: string, older: ChatMessage[]): Promise<string> {
  const sig = signatureOf(older);
  const cached = summaryCache.get(taskId);
  if (cached && cached.sig === sig) return cached.summary;

  try {
    const route = await resolveRoute();
    const { system, user } = compactPrompt(older);
    const { text, error } = await completeOnce({
      provider: route.provider,
      model: route.model,
      messages: [{ role: "user", content: user }],
      system,
    });
    // 通道那头报错也算失败 → 走下面的降级（不把错误当摘要写进去）
    if (error) return "";
    const summary = text.trim();
    if (summary) summaryCache.set(taskId, { sig, summary });
    return summary;
  } catch {
    /*
     * 压缩失败**不是**这一次对话的失败：降级成"发截断后的完整历史"（§147 的行为）。
     * 沉默地吞掉是对的 —— 用户不需要知道"后台那次摘要调用失败了"，
     * 他需要的是这轮对话照常进行。
     */
    return "";
  }
}

/**
 * 用"接着聊"那条路回答一句（§147 / §149 / §151 共用）。
 *
 * 抽出来是因为现在有**两个**入口走这条路：用户自己接着说一句（`sendInTask`），
 * 以及**回退之后重新回答**（`rewindTask`）。两处各写一份的话，
 * 压缩与历史那套逻辑早晚会在其中一处悄悄过期 —— 而那种错极难从现象上看出来。
 *
 * @param taskId 哪段对话
 * @param history 这次**之前**的步骤（不含这次要发的那句）
 * @param text 这次要发的那句
 */
export async function answerTurn(
  port: StorePort,
  taskId: string,
  history: TaskStep[],
  text: string,
  extraNote?: string,
  /** 这一轮随用户话一起带的资料（见 `WorkTask.material`）：空则只用任务上那份。 */
  material?: string,
): Promise<void> {
  const { messages, truncated } = buildHistory(history, { factor: calibrationFactor });

  /*
   * 上下文压缩（§149）。
   *
   * 顺序很要紧：**先按消息边界切、再决定压不压**，压成功才只发 recent + 摘要。
   * 压失败就退回"发截断后的完整历史" —— 不能因为压缩失败就把更早的内容
   * 悄悄丢掉（那等于压缩把上下文弄丢了）。
   */
  const keepTokens = compactKeepTokens();
  let effective = messages;
  let summary = "";
  let olderCount = 0;
  if (shouldCompact(messages, keepTokens)) {
    const { older, recent } = planContext(messages, keepTokens);
    if (older.length > 0) {
      summary = await summaryFor(taskId, older);
      if (summary) {
        effective = recent;
        olderCount = older.length;
      }
    }
  }

  const { system: baseSystem, user } = buildFollowUpPrompt(text, truncated, material);
  const system = withSummary(baseSystem, summary);
  const reply = await runStream(
    port,
    user,
    system,
    (patch) => {
      port.setState((s) => ({ tasks: upsertTask(s.tasks, { ...current(s.tasks, taskId), ...patch }) }));
    },
    effective,
    taskId,
  );

  /*
   * 这一步要额外告诉用户的话。两种来源合并：
   * ① `extraNote` —— 例如"已回到这一步重新回答"（§151）；
   * ② 压缩提示（§149）。
   * 合成一行而不是两条：界面上那一行本来就只放一句。
   */
  const notes = [extraNote, reply.note, olderCount ? compactedNote(olderCount) : ""].filter(Boolean);
  nextStep(
    port,
    taskId,
    reply.text,
    false,
    user,
    reply.tools,
    notes.length ? notes.join("；") : undefined,
    reply.usage,
  );
}

/**
 * 跑一次流式请求，把增量写进当前任务的活动状态。
 *
 * @param user 用户内容
 * @param system 系统提示词（已拼好摘要）
 * @param onPatch 把增量状态合并进任务
 * @returns 模型的完整输出
 */
export async function runStream(
  port: StorePort,
  user: string,
  system: string,
  onPatch: (patch: Partial<WorkTask>) => void,
  /**
   * 之前几轮的历史（§147）。
   *
   * 缺省为空 = 只发这一句（`createTask` / 起标题 / 重生成那些路径就是如此）。
   * 传了历史就是多轮：**旧消息在前、这次的新消息在后** —— 顺序反了模型会把因果读反。
   */
  history: ChatMessage[] = [],
  /**
   * 这一轮属于哪个会话（C2）：主进程据此把请求与事件写进会话日志。
   *
   * 工作台用**任务 id**（一段任务就是一段会话）；不给就不记日志 ——
   * 起标题这类附带请求走的是别的函数，压根不到这里。
   */
  sessionId = "",
): Promise<{ text: string; tools: ToolTrace[]; usage?: StepUsage; note?: string }> {
  const messages: ChatMessage[] = [...history, { role: "user", content: user }];
  /*
   * ⚠️ 「新对话默认模型」（§183）只在这种时候生效：
   * **这条对话还没有任何历史**（`history` 为空 = 这就是第一句）。
   *
   * 默认模型不该劫持一段正在进行的对话 —— 用户在那段里手动换过模型，
   * 再发一句又被拽回默认，那是很讨厌的事。
   */
  const route = await resolveRoute({ fresh: history.length === 0 });
  /*
   * 钉的默认模型失效了就说一句（§184）。
   *
   * ⚠️ note 挂在**步骤**上（§149 那个机制），所以这里先记在局部变量里、
   * 跟着返回值交给 `answerTurn` —— 不能直接 `onPatch({ note })`（那是任务字段）。
   */
  const fellBackNote = route.fellBack && route.pinned ? fallbackNote(route.pinned) : "";
  // 启用能力拼在系统提示词末尾：任务本身的要求在前，能力说明在后
  /*
   * 选中的 AI 智能体（§156）：它的「设定描述 + 标签」要拼进系统提示词 ——
   * 模型看不到我们那些数组，只有写进去它才会以那个身份说话。
   * 放在能力说明**之前**：人设是"你是谁"，能力是"你能用什么"。
   */
  const persona = agentPromptBlock();
  // 记下"这一轮发出去的东西"的估算量（补完④），收尾时与真实 usage 一起算系数
  const extra = await enabledBlock();
  /*
   * 长期记忆（§164）：工具描述里一直写着"之后每次对话都会自动带上"，
   * 而 `memoryPromptBlock` **从来没被调用过** —— 描述与现状不一致。
   * 这里补上：放在人设之后、能力说明之前。
   */
  const remembered = memoryPromptBlock(useMemoryStore.getState().lib);
  /*
   * 装配收成一份纯函数（C2-4）：聊天侧用的是**同一个** `assembleSystem`。
   * 不这么做的时候两边是各写一遍的 —— 于是聊天侧压根没有记忆与人设（实测）。
   */
  const fullSystem = assembleSystem({ base: system, persona, memory: remembered, abilities: extra });
  /**
   * 这一轮的**投影**（C2）：正文、工具留痕、用量只有一份算法。
   *
   * ⚠️ 这里原来是**第二份**手写状态机（`acc` + `tools` + `inputs` 那个 Map），
   * 与聊天侧那份各写一遍，于是两边慢慢答得不一样 —— 这一侧最刺眼的一条是：
   * `onEvent` **没有 `done` 分支**，主进程发来的真实 `usage` 落到这里就没了
   * （界面上的「消耗」因此一直是按字数估的）。
   *
   * 现在与聊天侧共用 `applyEvent`（`shared/sessionLog.ts`）。
   * ⚠️ 界面显示的那个数**本轮不动**（仍按原口径估）—— 换成真实用量是 C5 的事，
   * 这里只保证"真实用量不再被丢掉"（`view.usage`）。
   */
  let turn = emptyTurn();
  /**
   * 工作台**展开**子智能体上交的调用（`expandBlocked`，§176）：
   * 它们挂成这一步上的待批准项，用户能就地放行 —— 这是原有行为。
   */
  const project = () => finishTurn(turn, { expandBlocked: true });

  onPatch({ activity: "正在思考", stage: "running" });

  /** `catch` 里抛出来的错误。与投影里的 `error` 事件是两条路，按"后者发生者优先"合。 */
  let failure = "";

  try {
    const handle = await streamChat(
      {
        provider: route.provider,
        model: route.model,
        messages,
        system: fullSystem,
        // 审批档位随请求过界（§143）：模式选择在这侧，工具执行在那侧
        toolPolicy: readConfirmMode(),
        // 只有"回答用户"这条路径才带工具；起标题等附带请求不带（§143）
        useTools: true,
        // 会话日志（C2）：主进程把这一轮完整记下来（请求体 / 事件 / 用量）
        ...(sessionId ? { sessionId } : {}),
      },
      (event) => {
        /*
         * ⭐ **先过投影，再管界面**（C2）：界面只是投影的一种呈现。
         * 反过来的话（先写界面、再"顺便记一下"），两边迟早会漂移 ——
         * 这一侧原来就是这么漂掉的（`done` 里的 usage 没人接）。
         */
        turn = applyEvent(turn, event);

        if (event.type === "text") {
          /*
           * 把正在长出来的正文一起 patch 进去（2026-10-14）：原来这里只改 activity，
           * 用户看到的只有一行「正在回复」，整段回答结束时才蹦出来 —— 而聊天侧一直逐字显示。
           * 正文取自投影（finishTurn(turn).text）：与收尾时落成一步用的是同一份数据。
           */
          onPatch({ activity: "正在回复", draft: finishTurn(turn).text });
        }
        if (event.type === "tool-call") {
          /*
           * 让用户**当场看见**模型在调工具 —— 否则"记忆被写进去了"是暗箱操作。
           * 文案只说"正在使用"，具体结果等 tool-result 到手再落。
           *
           * 参数不用自己存了：投影里已按 `toolCallId` 配好对（原来这里有个 `inputs` Map）。
           */
          onPatch({ activity: `正在使用${toolLabel(event.toolName)}` });
        }
        if (event.type === "tool-result") {
          /* 「等你确认」还是「正在回复」也取自投影（`pending` 只判一次） */
          const trace = project().traces.find((t) => t.toolCallId === event.toolCallId);
          onPatch({ activity: trace?.pending ? "等你确认" : "正在回复" });
        }
        // error 不在这里处理：投影里记着，收尾时统一取（见下）
      },
    );
    port.setState({ runningRequestId: handle.requestId });
    // 记下这条流：`abort()` 要能调它的本地 settle（见那里关于两个 abort 的说明）
    activeHandle = handle;
    await handle.done;
    activeHandle = null;
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
  }
  port.setState({ runningRequestId: null });
  /* 收尾清掉流式草稿（正文已经落成那一步了，再留着会出现两份）。 */
  onPatch({ draft: undefined });

  /*
   * 收尾：正文与工具留痕都从投影取。
   *
   * 错误那句话的优先级与原来一致：`catch` 里抛出来的（后发生）盖过 `error` 事件里的。
   */
  const view = project();
  /*
   * 收尾时更新校准系数（补完④）：估的是"system + messages"，与 provider 的
   * `usage.inputTokens` 同一口径。拿不到 usage（中止/报错）就保持原系数 —— **不编**。
   */
  lastRequestEstimate = estimateTokens(fullSystem) + totalTokens(messages);
  calibrationFactor = calibrationOf(lastRequestEstimate, view.usage?.inputTokens);
  const errorText = failure || view.error || "";
  const text = errorText ? `（出错了）${errorText}` : view.text;
  /*
   * ⚠️ `usage` 一起交出去（C5）：它是 provider 给的**真值**，
   * 原来主进程发了、工作台**没有 `done` 分支**于是直接丢掉（界面那个数一直是按字数估的）。
   * 现在它跟着这一步落盘，显示处据此**如实说明**"上面那个数是估的、真值是这个"。
   *
   * 「默认模型失效、先退回上次」那句跟着返回值出去，由 `answerTurn` 挂到这一步上（§184）
   */
  return {
    text,
    tools: view.traces,
    ...(view.usage ? { usage: view.usage } : {}),
    ...(fellBackNote ? { note: fellBackNote } : {}),
  };
}

/**
 * 处理一段模型输出：能解出提问卡就切到「等待用户」，否则收尾。
 *
 * 收尾前会**把产物提取出来并真的写到磁盘**（阶段 11.1）——
 * 原版的产物是真文件，右侧「对话产物」点开就能看，所以这里不做"只在内存里"的假产物。
 *
 * @param taskId 任务 id
 * @param raw 模型原始输出
 * @param isDoPhase 是否处于第二段（第二段的追问不再无限套娃，只收一次）
 */
/**
 * 把一次模型输出落成一条 AI 回复。
 *
 * @param taskId 归属任务
 * @param raw 模型原始输出
 * @param isDoPhase 是否处于"开始干活"阶段（第一阶段会解析提问块）
 * @param askedWith 这一轮**实际发出去的用户内容**（「重新生成」要原样重跑）
 * @param tools 这一轮用过的工具（§141）；空数组与"没传"等价，都不写字段
 */
export function nextStep(
  port: StorePort,
  taskId: string,
  raw: string,
  isDoPhase = false,
  askedWith?: string,
  tools: ToolTrace[] = [],
  /** 这一步额外要说的一句（§149：目前只用于"更早的对话已压缩为摘要"）。 */
  note?: string,
  /** 这一步的**真实用量**（C5）：与界面那个估出来的 `cost` 一起留着，hover 里如实说。 */
  usage?: StepUsage,
): void {
  const state = port.getState();
  const task = state.tasks.find((t) => t.id === taskId);
  if (!task) return;

  // 先解提问块（拿正文 + 待问的问题），再从正文里解产物块。
  // 顺序不能反：提问块标记也在正文里，先拆掉它才不会把它的内容当产物。
  const ask = parseAskReply(raw);
  const stepId = makeStepId(task.steps.length + 1);
  const { text, artifacts } = extractArtifacts(
    ask.text,
    taskId,
    Date.now(),
    (i) => `${taskId}-a${i + 1}`,
    stepId,
  );
  const questions = ask.questions;

  const steps = [
    ...task.steps,
    {
      id: stepId,
      role: "assistant" as const,
      text: text || (artifacts.length ? "产物已生成，见右侧「对话产物」。" : "(没有输出内容)"),
      at: Date.now(),
      ...(askedWith ? { askedWith } : {}),
      // 原版会显示「消耗 0.48」（**按额度**，本机没有额度体系）—— 这里按字数估一个同口径可比的数
      cost: fabricatedCost(raw),
      // 真实用量（provider 的 tokens）如实存下来，界面的 hover 里说出来（C5）
      ...(usage ? { usage } : {}),
      // 工具留痕挂在**这一步**上（step 事件化）：哪一步用了什么工具，是从这里读的
      ...(tools.length ? { tools } : {}),
      ...(note ? { note } : {}),
    },
  ];

  if (artifacts.length > 0) {
    port.setState({
      tasks: upsertTask(state.tasks, { ...task, steps, artifacts: [...task.artifacts, ...artifacts] }),
    });
    // 落盘是异步的，不挡界面：先让列表出现，再把字节数补上
    void persistArtifacts(port, taskId, artifacts);
  }

  const withSteps: WorkTask = {
    ...(port.getState().tasks.find((t) => t.id === taskId) ?? task),
    steps,
  };

  if (questions.length > 0) {
    port.setState({
      tasks: upsertTask(state.tasks, {
        ...withSteps,
        questions: acceptQuestions(questions),
        questionIndex: 0,
        stage: "awaiting",
        activity: "正在询问用户",
      }),
    });
    return;
  }

  // 没解出提问卡：收尾
  port.setState({
    tasks: upsertTask(state.tasks, {
      ...withSteps,
      stage: "done",
      finishedAt: Date.now(),
      activity: isDoPhase ? "已完成" : "已完成",
    }),
  });
}

/**
 * 把产物写进磁盘上的产物目录，回填字节数。
 *
 * 文本类产物直接写正文；Office 三类先按 Markdown 落盘（见 HANDOFF §27 的说明：
 * 真正的 docx/pptx/xlsx 生成是下一步，这里不假装已经做到）。
 */
export async function persistArtifacts(port: StorePort, taskId: string, artifacts: Artifact[]): Promise<void> {
  const bridge = (window as unknown as { shell?: ShellBridge }).shell;
  if (!bridge?.workbench) return;
  for (const artifact of artifacts) {
    try {
      const content = artifact.content ?? "";
      const saved = await bridge.workbench.saveArtifact(artifactFileName(artifact), content);
      port.setState((s) => ({
        tasks: s.tasks.map((t) =>
          t.id !== taskId
            ? t
            : {
                ...t,
                artifacts: t.artifacts.map((a) =>
                  a.id === artifact.id ? { ...a, filePath: saved.filePath, bytes: saved.bytes } : a,
                ),
              },
        ),
      }));
    } catch {
      // 落盘失败不影响对话流：界面上那条产物仍然在，只是没有 filePath
    }
  }
}

/**
 * 中止当前这条流（`store.ts` 的 `abort` action 整段搬过来的）。
 *
 * 放在 `taskRuntime.ts` 里是因为 `activeHandle` 只由 `runStream` 写：
 * "怎么中止这条流"必须和"谁持有它"待在一起，分两处迟早对不上。
 */
export function abortRunning(port: StorePort): void {
  /*
   * ⚠️ 走**流自己的** `abort()`，不是只发 `abortStream(id)`（补完⑤时逮到的真 bug）。
   *
   * 两者的区别是实打实的：`abortStream(id)` 只让**主进程**断开 provider 连接，
   * 渲染层这条 `handle.done` **永远不会 resolve** —— 于是 `runStream` 卡在 await 上、
   * `nextStep` 不执行：**那一步不落盘、任务永远停在"正在回复"**（实测：点停止之后
   * 界面上什么都没有，`tasks.json` 里也没有那一步，而日志里已经有「已中止」——那正是
   * `accept-abort.mjs` 把两边分开断言才看出来的）。
   *
   * `handle.abort()` 一次做两件：断主进程的连接 + **本地 settle**（抛一条「已中止」事件），
   * 于是收尾逻辑照常跑，那一步照常落盘并如实写着「已中止」。
   */
  activeHandle?.abort();
  if (!activeHandle) {
    const id = port.getState().runningRequestId;
    if (id) void import("../ai/aiClient").then((m) => m.abortStream(id));
  }
  port.setState({ runningRequestId: null });
}
