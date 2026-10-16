import { MAX_PINNED } from "@shared/library";
import type { WorkTask } from "./task";

/**
 * 任务中心（`chat/task-center`，§154）。
 *
 * ## 证据
 *
 * 文案逐字取自 `docs/evidence-taskcenter.txt`（`appEntryManage_*` 13 条，  ⚠️（该依据未入库、本机也找不到 —— 无法复核；判据以本文件里的断言为准）
 * 从本体前端包抠出来的）。还有半条链路来自 `m_chat_goal_*`：
 * 「告诉豆包你想做什么，豆包会帮你持续跟进。**你可以随时在任务中心查看进展和结果**。」
 *
 * ## 三块内容（本体 bottomSheet 的三个 header）
 *
 * | 键 | 文案 |
 * |---|---|
 * | `_header_ongoing` | 进行中的任务 |
 * | `_header_recentlyVisited` | 最近访问 |
 * | `_header_explore` | 发现更多服务 |
 *
 * 空态那句把三块一起说了：「置顶、最近访问的内容和进行中的任务将展示在这里」——
 * 也就是说**置顶的东西也在这个面板里**（按本体习惯排在最前）。
 */

/** 界面文案（**逐字取自证据**，别顺手改措辞）。 */
export const CENTER_LABELS = {
  title: "任务中心",
  ongoing: "进行中的任务",
  recent: "最近访问",
  explore: "发现更多服务",
  empty: "置顶、最近访问的内容和进行中的任务将展示在这里",
  viewMore: "查看更多",
  pin: "置顶",
  unpin: "取消置顶",
  stopDeleteDesc: "移除同时将停止当前任务",
  stopDelete: "移除并停止",
  cancel: "取消",
  notFound: "未查找到对应的消息",
} as const;

/** 最近访问默认给几条（超出走「查看更多」）。 */
export const RECENT_LIMIT = 6;

/**
 * 置顶满了时的提示（`appEntryManage_bottomSheet_toast_exceedPinItem` = 最多可置顶 {s_maxPinNo} 个服务）。
 *
 * ⚠️ 上限值本体是**服务端下发**的（文案里是占位符 `{s_maxPinNo}`），
 * 本机版取 `MAX_PINNED = 8`（与库模块同一处口径，不另定一个数）。
 *
 * @param limit 上限
 * @returns 提示文案
 */
export function pinLimitToast(limit = MAX_PINNED): string {
  return `最多可置顶 ${limit} 个服务`;
}

/**
 * 能不能置顶。
 *
 * 为什么要先问再点：库里的 `togglePinned` 在**满的时候静默返回原对象** ——
 * 界面上什么都不发生。而本体这里是有明确提示的（上面那句），
 * 所以判断要挪到界面这一侧，才能把原因说出来。
 *
 * @param pinned 已置顶的 id
 * @param id 想置顶的那个
 * @param limit 上限
 * @returns `ok=false` 时 `reason` 是给用户看的原因
 */
export function canPin(
  pinned: readonly string[],
  id: string,
  limit = MAX_PINNED,
): { ok: boolean; reason?: string } {
  if (pinned.includes(id)) return { ok: false, reason: "已经置顶了" };
  if (pinned.length >= limit) return { ok: false, reason: pinLimitToast(limit) };
  return { ok: true };
}

/** 一段对话"还在进行中"吗（`中进行中的任务` 那一块收的就是这些）。 */
export function isOngoing(task: Pick<WorkTask, "stage">): boolean {
  return task.stage === "running" || task.stage === "awaiting";
}

/**
 * 把任务分到三块里。
 *
 * @param tasks 全部任务
 * @param limit 最近访问最多显示几条
 * @returns `ongoing` 进行中；`recent` 其余（**最近访问**在前）；`more` 被「查看更多」挡住的条数
 */
export function centerSections(
  tasks: readonly WorkTask[],
  limit = RECENT_LIMIT,
): { ongoing: WorkTask[]; recent: WorkTask[]; more: number } {
  const ongoing: WorkTask[] = [];
  const rest: WorkTask[] = [];
  for (const t of tasks) {
    if (isOngoing(t)) ongoing.push(t);
    else rest.push(t);
  }
  /*
   * ⚠️ 「最近访问」按**访问时刻**排（2026-10-16 审计 P266）。
   *
   * 原来两边都按 `createdAt` —— 而这一栏的注释写的是"刚访问过就该排前面"：
   * 昨天建的、今天又聊了几轮的对话会排在今天新建的**后面**，
   * 用户看到的是「最近创建」而不是「最近访问」。
   *
   * 次序：`openedAt`（点开或接着说一句时更新）→ 最后一步的时刻（老数据没记访问时刻，
   * 但它什么时候说过话是知道的）→ `createdAt`。三级回落都不编数。
   */
  const when = (t: WorkTask): number => t.openedAt ?? latestStepAt(t) ?? t.createdAt;
  ongoing.sort((a, b) => when(b) - when(a));
  rest.sort((a, b) => when(b) - when(a));
  return {
    ongoing,
    recent: rest.slice(0, limit),
    more: Math.max(0, rest.length - limit),
  };
}

/** 最后一步的时刻（没有任何步骤时 null）。 */
function latestStepAt(task: WorkTask): number | null {
  let latest: number | null = null;
  for (const step of task.steps) {
    if (typeof step.at === "number" && (latest === null || step.at > latest)) latest = step.at;
  }
  return latest;
}

/**
 * 把置顶的排到最前（其余保持原顺序）。
 *
 * @param tasks 一串任务
 * @param pinned 置顶的 id（顺序即置顶顺序）
 * @returns 新数组（不改原数组）
 */
export function orderByPinned<T extends { id: string }>(tasks: readonly T[], pinned: readonly string[]): T[] {
  const rank = new Map(pinned.map((id, i) => [id, i]));
  return [...tasks].sort((a, b) => {
    const ra = rank.has(a.id) ? (rank.get(a.id) as number) : Number.MAX_SAFE_INTEGER;
    const rb = rank.has(b.id) ? (rank.get(b.id) as number) : Number.MAX_SAFE_INTEGER;
    return ra - rb;
  });
}

/** 移除任务时要不要先问一句（在跑的对话，移除会把当前这次也停掉）。 */
export function needsStopConfirm(task: Pick<WorkTask, "stage">): boolean {
  return isOngoing(task);
}
