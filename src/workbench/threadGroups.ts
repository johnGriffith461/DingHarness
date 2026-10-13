import type { WorkTask } from "./task";

/**
 * 「管理历史对话」页的时间分桶与行摘要（纯逻辑，可单测）。
 *
 * 依据：本体该页的实机截图 `app-triage/dynamic-ui/shot-route-thread-list.png`
 * （路由 `chrome://doubaowork-chat/chat/thread/list`）。
 * 截图里能看到三档分组：**近一年 / 昨天 / 近 7 天**。
 *
 * ⚠️ 一点如实说明：截图只出现了那三档。下面这张桶表把它**补成一条完整的时间序列**
 * （今天 / 昨天 / 近 7 天 / 近 30 天 / 近一年 / 更早）—— 那三档是**观察到的**，
 * 其余三档是**按同一序列补的**，不是从本体读出来的。补的理由是"新 → 旧"必须连续，
 * 否则新任务会掉进「近一年」那种明显不对的桶里。
 */

/** 一个任务"最近一次活动"的时间：创建时间与全部步骤时间的最大值。 */
export function lastActiveAt(task: WorkTask): number {
  let at = task.createdAt || 0;
  for (const step of task.steps) {
    if (step.at > at) at = step.at;
  }
  return at;
}

/** 分桶用的档位（顺序即展示顺序：新 → 旧）。 */
export const THREAD_BUCKETS = ["今天", "昨天", "近 7 天", "近 30 天", "近一年", "更早"] as const;
export type ThreadBucket = (typeof THREAD_BUCKETS)[number];

const DAY = 24 * 60 * 60 * 1000;

/** 本地时间的当天 0 点 —— 分桶按**自然日**算，不是按"差了几个 24 小时"。 */
function dayStart(ts: number): number {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** 今天 0 点与那天 0 点相差几个自然日。 */
function daysAgo(at: number, now: number): number {
  return Math.round((dayStart(now) - dayStart(at)) / DAY);
}

/** 某个时间点属于哪一档。 */
export function bucketOf(at: number, now: number): ThreadBucket {
  const ago = daysAgo(at, now);
  if (ago <= 0) return "今天";
  if (ago === 1) return "昨天";
  if (ago <= 7) return "近 7 天";
  if (ago <= 30) return "近 30 天";
  if (ago <= 365) return "近一年";
  return "更早";
}

export type ThreadGroup = { label: ThreadBucket; tasks: WorkTask[] };

/**
 * 按时间分桶，桶内按最近活动时间**从新到旧**。
 * 空桶不产出（本体截图里也没有空标题）。
 */
export function groupThreads(tasks: WorkTask[], now: number): ThreadGroup[] {
  const groups: ThreadGroup[] = [];
  for (const label of THREAD_BUCKETS) {
    const inBucket = tasks
      .filter((t) => bucketOf(lastActiveAt(t), now) === label)
      .sort((a, b) => lastActiveAt(b) - lastActiveAt(a));
    if (inBucket.length > 0) groups.push({ label, tasks: inBucket });
  }
  return groups;
}

/** 摘要长度上限 —— 行内单行截断，超出由 CSS 收尾。 */
export const THREAD_SUMMARY_LIMIT = 64;

/**
 * 一行的摘要文本。
 *
 * 取**最后一条有内容的步骤**（用户或 AI 都算）—— 本体截图里每一行都是一句
 * 与内容相关的话。**一条都没有时显示「打开对话」**：这个默认值不是我编的，
 * 截图里「新画布」那几行就是这四个字（空会话的占位）。
 */
export function summaryOf(task: WorkTask): string {
  for (let i = task.steps.length - 1; i >= 0; i -= 1) {
    const text = (task.steps[i]?.text ?? "").replace(/\s+/g, " ").trim();
    if (text) return text.length > THREAD_SUMMARY_LIMIT ? text.slice(0, THREAD_SUMMARY_LIMIT) + "…" : text;
  }
  const brief = (task.brief ?? "").replace(/\s+/g, " ").trim();
  if (brief) return brief.length > THREAD_SUMMARY_LIMIT ? brief.slice(0, THREAD_SUMMARY_LIMIT) + "…" : brief;
  return "打开对话";
}
