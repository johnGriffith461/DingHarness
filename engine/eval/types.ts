import type { ConfirmMode } from "../../shared/ipc";
import type { EvalReply } from "./fakeProvider";

/**
 * 评测集的类型（Phase 10.1）。
 *
 * ## 判据为什么是"事件序列 + 关键文案 + 产物存在性"这三样
 *
 * 方案 10.1 原文就是这么定的，理由经得起推敲：
 *
 *   · **事件序列**回答"过程对不对"（有没有调工具、有没有被闸门拦下、有没有压缩）——
 *     只看最终文本的话，"模型直接编了个答案"与"它真的看了文件"长得一模一样；
 *   · **关键文案**回答"回注有没有到"（工具报错、闸门拦截、限额提示这些话必须原样出现）——
 *     它是用户唯一能看见的"发生了什么"；
 *   · **产物存在性**回答"有没有真的动手"（文件是不是真落盘了）——
 *     这一条挡的是"嘴上说写了、其实没写"。
 *
 * 三样都断，才叫"这一格验过了"。
 */

/** 六类评测集（方案 10.1 的原文分类）。 */
export const EVAL_CATEGORIES = [
  "纯对话",
  "工具调用",
  "闸门审批",
  "子智能体",
  "上下文压缩",
  "多 agent 协作",
] as const;

export type EvalCategory = (typeof EVAL_CATEGORIES)[number];

/** 一条用例的期望（三样判据都在这）。 */
export type EvalExpect = {
  /**
   * 事件序列：`TurnEvent.type` 的**子序列**（按顺序出现即可，中间允许有别的事件）。
   *
   * 为什么是子序列而不是全等：事件流里本来就有 `step-start` / `step-finish` / `text` 这些
   * 与"过程语义"无关的帧；写成全等会让用例跟着实现细节漂。
   */
  events?: string[];
  /** 关键文案：**必须出现**在（事件 + 工具结果 + 日志）拼起来的所有文本里。 */
  copy?: string[];
  /** 产物：工作目录里必须存在的文件（相对路径）。 */
  files?: string[];
  /** 不该存在的文件（挡"说要删/说不写，其实都做了"）。 */
  filesAbsent?: string[];
  /** 闸门：这一轮结束后**必须**有/没有待决审批。 */
  gate?: "pending" | "none";
  /** 事件序列里**不该出现**的类型（挡"说不该调工具，其实调了"）。 */
  eventsAbsent?: string[];
  /** 最少步数（挡"根本没走第二步"）。 */
  minSteps?: number;
  /** 必须有这么多次委派事件（子智能体 / 多 agent 两类用它）。 */
  delegations?: number;
  /** 这些工具必须**以失败收场**（`tool-result` 带 error）。 */
  toolErrors?: string[];
  /** 必须有用量账本（有真实 usage）。 */
  usage?: boolean;
};

/** 一条评测用例。 */
export type EvalCase = {
  /** 稳定 id（基线按它比对；改 id 等于新增一条）。 */
  id: string;
  category: EvalCategory;
  /** 一句话说清"这一格在验什么"。 */
  title: string;
  /**
   * `turn`（默认）：走一轮真的 agent 回合（脚本化 provider）；
   * `core`：只跑一个**纯函数判据**（见 `coreCheck`）。
   *
   * ⚠️ 为什么要有 `core` 这一类：「上下文压缩」的判据**不在回合里** ——
   * 压缩是**宿主**的编排（它决定发多少历史），而它的尺子（阈值 / 保留多少 / 回注什么话）
   * 在核心里。硬塞进回合流就得造一个假宿主，那时测的是假宿主而不是产品。
   */
  kind?: "turn" | "core";
  /**
   * 纯函数格子的判据：返回**失败原因**（`null` = 通过）。
   *
   * ⚠️ 它必须是**可证伪的**：写"看起来对"没用 —— 下面是读代码推不出来的那些数
   * （阈值、上下限、逐字文案），写错就会红。
   */
  coreCheck?: () => string | null;
  /** 用户说的话（多轮 = 多个元素，按顺序各跑一轮）。`core` 类不需要。 */
  turns?: string[];
  /** 每一轮 provider 该怎么回（与 `turns` 等长）。`core` 类不需要。 */
  replies?: EvalReply[][];
  /** 闸门档位（默认"按需确认"）。 */
  mode?: ConfirmMode;
  /** 步数上限（默认 4）。 */
  maxSteps?: number;
  /** 给不给工具（默认给）。 */
  useTools?: boolean;
  /** 预置文件（相对工作目录）：`{ "a.txt": "内容" }`。用例里"读文件"类断言靠它。 */
  fixtures?: Record<string, string>;
  /** 三样判据。`core` 类不需要（它的判据在 `coreCheck` 里）。 */
  expect?: EvalExpect;
};
