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
import { formatCount, usageTotal } from "@shared/cost";
import { toolLabel, type ToolTrace } from "@shared/agentTools";
import { applyEvent, emptyTurn, finishTurn } from "@engine/core/events";
import { assembleSystem } from "@engine/core/assembly";
import { fabricatedCost, type StepUsage } from "@shared/cost";
import { calibrationOf, estimateTokens, totalTokens } from "@engine/core/context";
import {
  buildContextIndex,
  classifyClaim,
  decideContext,
  renderContextIndex,
  type ContextIndex,
  type ContextSignals,
} from "@engine/core/contextManager";
import { buildHistory } from "./history";
import { keepTokensFor, parseBudgetMode, type ContextBudgetMode } from "@engine/runtime/budget";

import { readSavedRoute } from "@/ai/route";
import { agentPromptBlock } from "./agentStore";
import { memoryPromptBlock } from "@shared/memory";
import { useMemoryStore } from "./memoryStore";
import { resolveChatRoute } from "@/ai/route";
import {
  compactedNote,
  compactPrompt,
  indexedNote,
  signatureOf,
  withContextIndex,
  withSummary,
} from "./compaction";
import { readConfirmMode } from "./confirmMode";
import { readReasoningEffort } from "./effortStore";
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
 * （见 `engine/core/context.ts` 的 `calibrationOf`）。
 *
 * ⚠️ 只放内存：系数是"这台机器 + 这个 provider"的当期口径，重启后重新学即可 ——
 * 落盘反而要担心"换了模型还在用旧系数"。
 */
/**
 * 当前在跑的流（补完⑤ + 2026-10-16 审计 P46）：中止要调它的本地 `abort()`，
 * 否则这一步永远不落盘。
 *
 * ⚠️⚠️ **按会话/轮次持有，不能是一个单值**（审计 P46 的真形状）。
 *
 * 原来这里是 `let activeHandle: {abort} | null` —— 一条流结束就把它置 null。
 * 而**同一段对话完全可能同时跑两轮**（`Composer.tsx` 的 Enter 分支不看 `running`，
 * `HomeView` 的按钮也不 disable）：第二条流一注册就把第一条顶掉，于是
 *   ① 点「停止」停的是**后开的那条**（用户想停的可能是前一条）；
 *   ② 前一条收尾时 `runningRequestId = null` 会把**还在跑的那条**的活动状态抹掉
 *      （界面上"正在回复"没了，而请求还在飞）。
 *
 * 键是**每一轮自己的编号**（不是会话 id）：同一会话并发两轮时键也不会撞，
 * 这正是上面那个场景。会话 id 记在值里，供"停这一段对话"按会话筛。
 */
type TurnHandle = {
  /** 这一轮的本地中止（`handle.abort()`，它会同时断主进程连接并 settle `done`）。 */
  abort: () => void;
  /** 主进程给的请求号（进度显示与兜底中止用）。 */
  requestId: string;
  /** 这一轮属于哪段对话（空串 = 没标会话）。 */
  sessionId: string;
};

/** 轮次键 → 句柄。一轮结束（或异常）就删掉**自己那一份**。 */
const activeHandles = new Map<string, TurnHandle>();
/** 轮次编号：只用于给上面那张表分配不撞的键。 */
let turnSeq = 0;

/**
 * 现在还有几轮在跑（`runningRequestId` 与"这段对话在跑吗"都从这一处算）。
 */
function liveTurns(sessionId?: string): TurnHandle[] {
  const all = [...activeHandles.values()];
  return sessionId === undefined ? all : all.filter((h) => h.sessionId === sessionId);
}

/**
 * 这段对话现在有流在跑吗（P46：入口守卫用它，避免同会话并发两轮互插日志）。
 *
 * @param sessionId 会话 id（工作台里就是任务 id）
 */
export function isSessionRunning(sessionId: string): boolean {
  return sessionId !== "" && liveTurns(sessionId).length > 0;
}

/**
 * 把「正在跑」的标志同步成**真实**的在跑轮数（P46）。
 *
 * 收尾时不能无条件写 null：那只说明**这一轮**结束了，别的轮可能还在跑。
 */
function syncRunningFlag(port: StorePort): void {
  port.setState({ runningRequestId: liveTurns()[0]?.requestId ?? null });
}

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
 * 这一轮的技能提示（G08）：**走主进程**读技能目录（渲染层没有 fs）。
 *
 * 失败/没配就返回空串 —— 技能是增强，不该让一轮跑不起来。
 */
async function skillsBlockFor(text: string): Promise<string> {
  const shell = (globalThis as unknown as { shell?: { skills?: { block: (t: string) => Promise<string> } } }).shell;
  try {
    return (await shell?.skills?.block?.(text)) ?? "";
  } catch {
    return "";
  }
}

/**
 * 保留额度（§149 / D04）。
 *
 * 正常按**当前模型窗口 + 预算档位**推导（`budget.ts`）。**本地存储里那个键是给验收用的开关** ——
 * 不然要验证"压了之后还能答对"，得先造一段两万 token 的真实对话（十几次模型调用）。
 * 界面上没有入口，生产不会有人设它。
 *
 * 读不到 / 读到乱值就回落默认值：这个值只影响"什么时候压"，不该让请求失败。
 */
function compactKeepTokens(): number {
  try {
    const raw = Number(localStorage.getItem("dsh-canvas.compact-keep-tokens"));
    if (Number.isFinite(raw) && raw > 0) return raw;
  } catch {
    /* 读不到 localStorage（测试/异常）→ 走下面的默认 */
  }
  /*
   * 没手动指定额度 → 按**当前模型的上限 + 档位**算（D04）。
   *
   * 档位默认 `long`（按窗口推导，1M 模型约 966k）；`balanced` / `economy` 可在
   * `~/.ding/config.json` 的 `contextBudget` 里显式选。
   * 未登记模型仍然 20k —— 不拿估计窗口发请求。
   */
  return keepTokensFor(readSavedRoute().model, Date.now(), readBudgetMode());
}

/** 桌面端读预算档位（与 CLI 配置同名同词；放 `localStorage` 是因为它只影响本机行为）。 */
function readBudgetMode(): ContextBudgetMode {
  try {
    return parseBudgetMode(localStorage.getItem("dsh-canvas.context-budget"));
  } catch {
    return "long";
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

/** 还没回答的澄清问题（ICM 的"未完成"信号之一）。 */
function unansweredQuestions(task: WorkTask): string[] {
  return task.questions.slice(task.questionIndex).map((q) => q.text);
}

/**
 * 从**已有事实**里取 ICM 信号（V6-1c）。
 *
 * ⚠️ 这里不读模型自述，只看三类真值：工具留痕（pending/失败/在跑检查）、
 * 未答问题、最近一条助手回复的**口径**（真假由 `decideContext` 拿证据判）。
 *
 * @param task 当前任务（可能还没建）
 * @param history 这一步之前的历史
 * @param tokens 全量历史估算
 * @param keepTokens 保留额度
 */
function contextSignalsOf(task: WorkTask | undefined, history: TaskStep[], tokens: number, keepTokens: number): ContextSignals {
  /* 只看最近几步：很久以前 pending 过的工具早已被处理，拿它当"活状态"会永远不压缩 */
  const recent = history.slice(-6);
  const tools = recent.flatMap((s) => s.tools ?? []);
  const pendingWork = tools.some((t) => t.pending);
  const runningChecks = tools.some(
    (t) =>
      Boolean(t.pending) &&
      t.name === "run_command" &&
      /(test|check|build|lint|测试|检查|构建|构建)/i.test(`${JSON.stringify(t.input ?? "")} ${t.line ?? ""}`),
  );
  const failedTools = tools.filter((t) => !t.ok && !t.pending).length;
  const openItems = task ? Math.max(0, task.questions.length - task.questionIndex) : 0;
  const lastAssistant = [...history].reverse().find((s) => s.role === "assistant");
  const claim = classifyClaim(lastAssistant?.text ?? "");
  return {
    tokens,
    keepTokens,
    pendingWork,
    openItems,
    failedTools,
    runningChecks,
    claim,
    evidenceComplete: !pendingWork && openItems === 0 && failedTools === 0 && !runningChecks,
    compactions: task?.contextCompactions ?? 0,
    hasFreshIndex: Boolean(task?.contextIndex),
  };
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
  /*
   * ⚠️ 与下面 `compactKeepTokens()` 用**同一把尺**（审计 P156：两把尺会让"该压就压"失真）。
   *
   * ⭐ V6-1c 修正了一个**静默失效**：`buildHistory` 返回的 `messages` 已经是切过的，
   * 再对它调 `shouldCompact` 几乎恒为假 —— 摘要那条路等于没接上，被切掉的旧内容
   * 只留下一句"已省略"。现在拿 `all` 算总量、拿 `older` 喂给 ICM。
   */
  const keepTokens = compactKeepTokens();
  const built = buildHistory(history, { factor: calibrationFactor, keepTokens });
  const { messages, truncated, all, older } = built;
  const task = current(port.getState().tasks, taskId);

  /*
   * ICM 裁决（V6-1c）：不是所有超额度都该摘要。
   *
   *   · `compact`   —— 旧内容可以压成要点（一次模型调用，有成本）；
   *   · `fork_index` —— 有活状态/假完成风险，改用**事件流索引**接力（0 次模型调用）；
   *   · `keep`      —— 没超额度。
   *
   * 压失败仍退回"发切过的历史"（不能因为摘要失败就把旧内容强行塞回去顶爆窗口）。
   */
  const decision = decideContext(contextSignalsOf(task, history, totalTokens(all), keepTokens));
  let effective = messages;
  let summary = "";
  let contextIndex: ContextIndex | null = null;
  let olderCount = 0;
  if (decision.action !== "keep" && older.length > 0) {
    if (decision.action === "compact") {
      summary = await summaryFor(taskId, older);
      if (summary) {
        olderCount = older.length;
        port.setState((s) => {
          const t = current(s.tasks, taskId);
          return {
            tasks: upsertTask(s.tasks, {
              ...t,
              contextCompactions: (t.contextCompactions ?? 0) + 1,
              contextIndex: undefined,
            }),
          };
        });
      }
    } else {
      /*
       * 索引从**已有事实**生成（任务目标/待办/产物），不调用模型。
       * 锚点用"这次请求前已有的事件条数"—— 回放时可以从此处核对。
       */
      contextIndex = buildContextIndex({
        sessionId: taskId,
        goal: task?.brief || task?.title || "",
        openItems: [
          ...(task ? unansweredQuestions(task) : []),
          ...(decision.action === "fork_index" ? [decision.reason] : []),
        ],
        artifacts: (task?.artifacts ?? []).map((a) => a.filePath || a.title).filter(Boolean),
      });
      olderCount = older.length;
      port.setState((s) => ({ tasks: upsertTask(s.tasks, { ...current(s.tasks, taskId), contextIndex: contextIndex ?? undefined }) }));
    }
  }

  const { system: baseSystem, user } = buildFollowUpPrompt(text, truncated, material);
  const system = contextIndex
    ? withContextIndex(baseSystem, renderContextIndex(contextIndex))
    : withSummary(baseSystem, summary);
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
  const contextNote = contextIndex ? indexedNote(olderCount) : olderCount ? compactedNote(olderCount) : "";
  const notes = [extraNote, reply.note, contextNote].filter(Boolean);
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
  /**
   * 这一轮的登记键（P46）：**每轮一个**，同一会话并发两轮也不会互相顶掉。
   * 用后固定顺序（编号 + 会话）便于排查："这是哪段对话的第几轮"。
   */
  const turnKey = `${sessionId || "anon"}#${(turnSeq += 1)}`;
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
  /*
   * 技能（G08）：从本机技能目录按"常驻 / 关键词 / 路径"选。
   * 选不到就是空串（不多出空行）。技能目录不存在也不报错 —— 那是正常状态。
   */
  const skillBlock = await skillsBlockFor(user);
  const fullSystem = assembleSystem({ base: system, persona, memory: remembered, skills: skillBlock, abilities: extra });
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

  /** 到目前第几步 / 累计 token（Phase 13.3 的进度叙述用；拿不到用量就不显示数字）。 */
  let liveSteps = 0;
  let liveTokens = 0;

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
        // 思考强度（2026-10-16）：没选过就是 undefined，一个字段都不多发
        ...(readReasoningEffort() === undefined ? {} : { reasoningEffort: readReasoningEffort() }),

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
        if (event.type === "step-finish") {
          /*
           * ⭐ **长回合进度**（Phase 13.3）：每一步结束时把"到第几步、已用多少 token"
           * 写进活动行。方案要求 CLI 与桌面**一致** —— 两边读的是同一个字段
           * （`step-finish` 的 `usage`），不是各算一份。
           *
           * 为什么要有它：长回合里用户只看到"正在回复"，十几分钟不知道在干什么、
           * 也不知道花了多少。有了步号与 token，他至少能判断"还要不要等"。
           * 拿不到用量就不显示数字（**不编**）。
           */
          /*
           * ⚠️ 兜底形态（**没有** `step` 字段）要与 CLI 说**同一句话**（2026-10-16 审计 P163）。
           *
           * `loop.ts` 在没收到 `finish-step` 时会发一条不带 step/usage 的 `step-finish`：
           * 桌面这里原来 `event.step ?? liveSteps + 1` 于是显示「第 1 步」，
           * 而 CLI（`ding.ts`）对同一个事件写的是「一步」—— 同一个事件两种说法。
           * 现在两边同一条判据：有步号说步号，没有就说「一步」。
           */
          liveSteps = event.step ?? liveSteps + 1;
          /*
           * ⚠️ **要累加**（2026-10-16，审计 P150）：`step-finish` 每次只带**这一步**的用量，
           * 而这里原来是赋值（`liveTokens = 这一步`）—— 于是进度行写的"已用 X token"
           * 其实是"刚这一步用了 X"，和同一轮的账本差一倍以上；变量上方的注释自己写的还是"累计"。
           * 现在把每一步加起来，与账本（`done` 事件的用量）是同一个口径。
           */
          const stepTokens = usageTotal(event.usage);
          if (stepTokens !== null) liveTokens += stepTokens;
          /* 有步号说步号；兜底形态（没有 step）说「一步」—— 与 CLI 逐字一致（P163） */
          const n = event.step === undefined ? "一步" : `第 ${liveSteps} 步`;
          const tk = liveTokens ? `，累计已用 ${formatCount(liveTokens)} token` : "";
          onPatch({ activity: `${n}${tk}` });
        }
        if (event.type === "delegation") {
          /*
           * 派活要有**期间状态**（Phase 7.3）：并行派三个专家时用户得看得见在等谁，
           * 否则那段时间界面只有一行"正在回复"，看着像卡住了。
           * 数目取自投影（不自己数事件——那就是第二份算法）。
           */
          const running = (finishTurn(turn).delegations ?? []).filter((d) => d.status === "started").length;
          onPatch({ activity: running ? `正在等 ${running} 个专家` : "正在回复" });
        }
        // error 不在这里处理：投影里记着，收尾时统一取（见下）
      },
    );
    /*
     * 登记**这一轮**（P46）：键按轮次分配，值里记着会话 id。
     * 别写成模块级单值 —— 那正是"第二条流顶掉第一条"的来源。
     */
    port.setState({ runningRequestId: handle.requestId });
    activeHandles.set(turnKey, { abort: handle.abort, requestId: handle.requestId, sessionId });
    try {
      await handle.done;
    } finally {
      // 只删自己那一份：同时跑的别人还在表里
      activeHandles.delete(turnKey);
    }
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
    activeHandles.delete(turnKey);
  }
  /*
   * ⚠️ 收尾**不能**无条件 `runningRequestId = null`（P46）：那只代表**这一轮**结束了，
   * 别的会话/别的轮可能还在跑。按表里还剩几轮来写。
   */
  syncRunningFlag(port);
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
 * 中止正在跑的流（`store.ts` 的 `abort` action 整段搬过来的）。
 *
 * 放在 `taskRuntime.ts` 里是因为句柄只由 `runStream` 写：
 * "怎么中止这条流"必须和"谁持有它"待在一起，分两处迟早对不上。
 *
 * ⚠️ **按会话/轮次中止**（2026-10-16 审计 P46）：原来只有一个 `activeHandle`，
 * 同会话并发两轮时它指向后开的那条 —— 点「停止」停的是**错的那一条**（用户以为停的是
 * 他在看的那一段）。现在：
 *   · 给了 `sessionId` → 只停**这一段对话**的轮次（界面上的「停止」就该是这个语义）；
 *   · 没给 → 停掉所有在跑的轮次（全局那一颗「停止」的语义）。
 *
 * @param port store 端口
 * @param sessionId 只停这段对话的轮次；不给就全停
 */
export function abortRunning(port: StorePort, sessionId?: string): void {
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
  const targets = liveTurns(sessionId);
  for (const handle of targets) handle.abort();
  if (targets.length === 0) {
    const id = port.getState().runningRequestId;
    if (id) void import("../ai/aiClient").then((m) => m.abortStream(id));
  }
  /* 被中止的那些会在自己的 `finally` 里出表；这里先把标志按真实剩余轮数写上 */
  for (const [key, handle] of [...activeHandles.entries()]) {
    if (sessionId === undefined || handle.sessionId === sessionId) activeHandles.delete(key);
  }
  syncRunningFlag(port);
}

