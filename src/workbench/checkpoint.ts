import type { TaskStep, WorkTask } from "./task";

/**
 * 会话检查点（§151）。
 *
 * ## 是什么
 *
 * 走到某一步之后，能**回到那里**再往下走 —— 两层意思：
 * ① **回退**：丢掉那之后的所有轮次，从那里重新回答；
 * ② **分支**：把"到那一步为止"的对话复制成一段新对话，两条路各自往下走。
 *
 * 设计取自两类系统的共同做法：每步可回的检查点，与会话树（一段对话可以分叉成多段，
 * 而不是只能线性的"最后一条"）。
 *
 * ## ⚠️ 必须说清的边界：回退**不撤销已发生的动作**
 *
 * 回退改的是**这段对话的记录与上下文**。已经发生的事改不回来：
 * 写进长期记忆的条目、加在画布上的节点、建好的定时任务、落盘的产物 —— **都还在**。
 *
 * 这不是偷懒，是这类系统的通性（对话是一层，副作用在别的地方）。
 * 但必须让用户知道 —— 所以界面上那个动作旁边写着"已发生的动作不会撤销"。
 */

/** 回退的结果。 */
export type RewindPlan = {
  /** 保留下来的步骤（含 `stepId` 那一步）。 */
  kept: TaskStep[];
  /** 丢掉了几步。 */
  dropped: number;
  /**
   * 回退之后要**重新回答**的那句用户话。
   *
   * 保留下来那批的最后一条若是 user，就重答它（"这一问重新来过"）；
   * 若是 assistant，就没有要重答的（用户接着往下说即可）。
   */
  reask: string | null;
};

/**
 * 算出"回到 `stepId` 为止"的结果。
 *
 * @param steps 现有步骤（旧 → 新）
 * @param stepId 回到哪一步（**保留它**）
 * @returns 计划；`stepId` 不存在时返回 null（磁盘上的东西不可信）
 */
export function planRewind(steps: readonly TaskStep[], stepId: string): RewindPlan | null {
  const index = steps.findIndex((s) => s.id === stepId);
  if (index < 0) return null;
  const kept = steps.slice(0, index + 1);
  const dropped = steps.length - kept.length;
  const last = kept[kept.length - 1];
  return {
    kept: [...kept],
    dropped,
    // 只在最后一条是用户话时才重答 —— 助手话结尾时"重答"没有对象
    reask: last && last.role === "user" ? last.text : null,
  };
}

/**
 * 从某一步**分叉**出一段新对话。
 *
 * 新任务拿到的是"到那一步为止"的同一批内容（**步骤 id 全部换新**）——
 * 不共用 id 是关键：两条分支各自往后走时，不能互相改到对方的那一步。
 *
 * @param task 原对话
 * @param stepId 分叉点（保留它）
 * @param newTaskId 新对话的 id
 * @param makeStepId 步骤 id 工厂 `(序号) => id`（由调用方给，便于测试）
 * @param now 时间戳
 * @returns 新对话；分叉点不存在时返回 null
 */
export function branchFrom(
  task: WorkTask,
  stepId: string,
  newTaskId: string,
  makeStepId: (ordinal: number) => string,
  now: number,
): WorkTask | null {
  const plan = planRewind(task.steps, stepId);
  if (!plan) return null;
  const steps = plan.kept.map((s, i) => ({ ...s, id: makeStepId(i + 1) }));
  return {
    ...task,
    id: newTaskId,
    title: `${task.title}（分支）`.slice(0, 60),
    createdAt: now,
    // 分支是一段**已经答过**的对话：不带着原对话的"运行中/等待中"状态过去
    stage: "done",
    startedAt: now,
    finishedAt: now,
    steps,
    questions: [],
    questionIndex: 0,
    activity: "",
    // 产物不复制：产物文件属于原对话那一份，复制会让"同一份产物挂两处"
    artifacts: [],
  };
}

/**
 * 用户在**哪一步**上点了"回退"→ 实际要回到哪一步。
 *
 * 界面上那个按钮长在**助手那一条**上，而用户的意图是"这条回答不想要，重来" ——
 * 所以实际要回到的是它**前面那句用户话**（保留它、重答它）。
 * 点在某句用户话上时就回到它自己。
 *
 * 抽成纯函数是因为这一步很容易差一格：回到助手那一步 = "止步于此"（不重答），
 * 回到它前面那句用户话 = "重新回答"。两者是不同的产品语义。
 *
 * @param steps 现有步骤
 * @param stepId 被点的那一步
 * @returns 实际要回到的步骤 id；找不到返回 null
 */
export function resolveRewindTarget(steps: readonly TaskStep[], stepId: string): string | null {
  const index = steps.findIndex((s) => s.id === stepId);
  if (index < 0) return null;
  const step = steps[index];
  if (!step) return null;
  if (step.role === "user") return step.id;
  for (let i = index - 1; i >= 0; i -= 1) {
    const prev = steps[i];
    if (prev?.role === "user") return prev.id;
  }
  // 前面没有用户话（例如一串助手话开头）：退回"止步于此"
  return step.id;
}

/** 界面上那个动作的说明（顺带把"不撤销副作用"这件事讲在明处）。 */
export const REWIND_HINT = "回到这一步，之后的轮次会丢掉；已经发生的动作（记忆、画布、定时任务、产物）不会撤销";

/**
 * C4：编辑一条用户消息后**新开的分支**（纯函数）。
 *
 * 语义与 `branchFrom` 的区别只有一处：**目标那条用户消息不被复制**，
 * 换成用户的 newText。其余（id 重发号、产物不带过去、状态回到 running 由调用方定）相同。
 *
 * @returns null = 这条不是用户消息 / 找不到
 */
export function editedBranchFrom(
  task: WorkTask,
  stepId: string,
  newText: string,
  newTaskId: string,
  now: number,
): WorkTask | null {
  const step = task.steps.find((s) => s.id === stepId);
  if (!step || step.role !== "user") return null;
  const plan = planRewind(task.steps, stepId);
  if (!plan) return null;
  const kept = plan.kept.slice(0, -1);
  const steps = kept.map((s, i) => ({ ...s, id: `${newTaskId}-s${i + 1}` }));
  steps.push({ id: `${newTaskId}-s${steps.length + 1}`, role: "user", text: String(newText ?? ""), at: now });
  return {
    ...task,
    id: newTaskId,
    createdAt: now,
    stage: "running",
    startedAt: now,
    finishedAt: null,
    steps,
    questions: [],
    questionIndex: 0,
    activity: "正在思考",
    artifacts: [],
  };
}
