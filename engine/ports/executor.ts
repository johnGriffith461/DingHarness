import type { ConfirmMode } from "../../shared/ipc";
import type { TurnEvidence } from "../runtime/finishContract";

/**
 * 工具执行的端口（Phase 1 D1 冻结）。
 *
 * ## 为什么执行体是端口而不是内核的一部分
 *
 * 内核负责"该不该执行"（策略、闸门、步数），**不负责"怎么执行"**：
 * `write_file` 落到哪个目录、`run_command` 用哪个 shell、`memory_save` 写哪个文件，
 * 全是**宿主的**事 —— 桌面宿主接的是用户授权的目录 + 各 store，
 * CLI 宿主接的是配置里的目录 + 一个纯文件系统实现。
 *
 * 所以内核只认一句话：**给我工具名和参数，我给你一个结果**。
 *
 * ## 结果的形状
 *
 * 与现有 `runToolOnce` 完全一致（`{ ok, output?, error? }`），一个字段都不改 ——
 * 这样"用户点允许后执行"那条既有路径可以原地接上来，不必先把返回值翻译一遍。
 *
 * ⚠️ **失败也是一种结果**（不变量 3，Factor 9）：`ok: false` 不抛异常，
 * 内核把它当一次工具结果回注给模型。执行体的契约是"永远返回一个结果"，
 * 而不是"出错就 throw" —— 抛出来的东西会中断整轮，那正是要防的。
 */
export type ToolResult = {
  ok: boolean;
  /** 给模型看的结果（形状由各工具自己定；投影会用 `describeToolResult` 生成那一行）。 */
  output?: unknown;
  /** 失败原因（一句话，给人看）。 */
  error?: string;
  /**
   * **图片内容块**（A-01，2026-10-22）。
   *
   * 以前截图类工具只回一个路径 —— 模型全程"看不见图"。现在执行体把图放在这里，
   * 注册表会把它组装成 AI SDK 的 `{ type:"content", value:[text, file] }`，
   * 模型真的能看到像素。
   *
   * ⚠️ **base64 绝不进会话日志**：投影只记 `line`/`path`（见 `engine/core/events.ts`
   * 的 `describeToolResult` 那条路），否则一份截图就能把日志撑爆。
   */
  media?: Array<{ mime: string; base64: string }>;
};

/**
 * 一次执行要用到的上下文。
 *
 * ⚠️ 字段与主进程现存的 `ToolEnv` **同名同义**，为的是让桌面宿主那侧
 * 不用写一层翻译（翻译层是"两个形状慢慢分叉"的起点）。
 */
export type ExecutorContext = {
  /** 闸门档位。执行体**不再自己判**（内核判过了），它只是需要知道，例如往下传。 */
  mode: ConfirmMode;
  /**
   * **这一轮的模型能不能看图**（A-01，2026-10-22）。
   *
   * 截图类工具据此决定：给图片内容块，还是退化成一句"我看不到"。
   * 唯一的权威来源是模型配置/目录的 `inputFormat.supportsImage`
   * （`engine/runtime/loop.ts` 算一次传下来，执行体不许自己猜）。
   */
  modelSupportsImage?: boolean;
  /** 这一轮的 provider / model（`spawn_agent` 派子智能体时要沿用同一个）。 */
  provider: string;
  model?: string;
  /** 这一轮的中止信号：用户点停时，工具内部（子智能体、跑命令）也得停。 */
  signal?: AbortSignal;
  /** 嵌套深度（防止子智能体再派子智能体）。 */
  depth?: number;
  /** D3：这段会话的 id（读后写校验的键；不给 = 不记读状态）。 */
  sessionId?: string;
  /**
   * **这段会话归谁的 id**（C3，V5-1 3.7a）：拦住一次调用时，默认的"待谁批"就是它。
   *
   * 缺省 = 本机单用户（判定层用 `DEFAULT_APPROVER` = `local` 兜底）—— 老路径一字不变。
   * 这是**归属**（谁能批这一段会话里的待决），不是"谁在说话"（那是 actor，C5）。
   */
  owner?: string;
  /**
   * 上报**委派进度**（Phase 7.3）。
   *
   * 派活的执行体在"某个专家开始/结束"时调它一次；内核负责把它记成 `delegation` 事件
   * 并转给宿主上屏。执行体自己**不碰**日志与 IPC —— 它只报告"发生了什么"。
   */
  onDelegation?: (event: {
    delegationId: string;
    agent: string;
    task: string;
    status: "started" | "finished";
    ok?: boolean;
    summary?: string;
    steps?: number;
    error?: string;
  }) => void;
  /**
   * P0-02：这一轮的**真实执行账本**（主循环维护、finish 执行体读取）。
   *
   * 省略 = 这个宿主没接账本（例如子智能体的工具集）：finish 执行体只做结构校验，
   * 证据校验由主循环用自己那份账本兜底。
   */
  turnEvidence?: TurnEvidence;
  /**
   * A-03：**就地审批**（宿主的出口）。
   *
   * `decideCall` 判出 `ask` 之后，内核不知道"人怎么回答" —— 桌面把调用挂起、
   * 等界面点批准；CLI 没有界面，只能当场问终端。判定仍然只有一份（policy），
   * 这里给的是"拿到人话之后怎么继续"的那一小段。
   *
   * 省略 = 保持老行为（返回 `{ pending: true }`，桌面路径一字不变）。
   */
  approve?: (req: {
    name: string;
    input: unknown;
    why?: string;
    commandRisk?: unknown;
    /**
     * F-07（2026-10-20）：这次调用在日志里的 id。
     *
     * 宿主用它把"问过/答过"记成一条可回放的 `approval` 记录 ——
     * 首小时指标要数确认次数，而 CLI 的就地审批原来在磁盘上**一点痕迹都没有**
     * （桌面那条路本来就有 pending 留痕）。
     */
    toolCallId?: string;
  }) => Promise<"allow" | "allow-always" | "deny">;
  /**
   * B-01：这一轮授权的目录（「接受编辑」档判断"是不是工作区内"要用）。
   *
   * 省略 = 不知道工作区 → 接受编辑档下所有编辑仍然确认（安全的一侧）。
   */
  workdirs?: readonly string[];
};

/**
 * 执行一个工具。
 *
 * ⚠️ **调用它 = 已经过闸门**。"需不需要用户确认"是内核的判定（`engine/core/policy.ts`），
 * 端口这一层不重复判 —— 两处都判的结果是"用户点了允许、还是执行不了"。
 */
export type ToolExecutor = {
  run(name: string, input: unknown, ctx: ExecutorContext): Promise<ToolResult>;
};
