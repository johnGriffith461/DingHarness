import type { WorkflowStepView } from "@shared/ipc";

/**
 * 工作流泳道的**可渲染形状**（V6-2l）。
 *
 * 按依赖分层：第一层是没有依赖的步骤，第二层是依赖都在第一层里的……
 * 同一层并行、层与层串行 —— 界面照这个画列，用户一眼能看出"卡在哪一层"。
 *
 * ⚠️ 成环/依赖不存在时不会死循环：认不出的步骤落到最后一层并标注（如实显示，不隐藏）。
 */

export type WorkflowLayer = {
  index: number;
  steps: WorkflowStepView[];
};

/**
 * 把步骤按依赖分层。
 *
 * @param steps 运行里的步骤
 * @returns 层（顺序 = 执行顺序）
 */
export function layersOf(steps: readonly WorkflowStepView[]): WorkflowLayer[] {
  const ids = new Set(steps.map((s) => s.id));
  const placed = new Set<string>();
  const layers: WorkflowLayer[] = [];
  let remaining = [...steps];

  while (remaining.length) {
    const ready = remaining.filter((step) => step.dependsOn.every((dep) => !ids.has(dep) || placed.has(dep)));
    if (!ready.length) {
      /* 成环/坏依赖：剩下的全放最后一层（界面标红由状态决定，不假装解析成功） */
      layers.push({ index: layers.length, steps: remaining });
      break;
    }
    layers.push({ index: layers.length, steps: ready });
    for (const step of ready) placed.add(step.id);
    remaining = remaining.filter((step) => !placed.has(step.id));
  }
  return layers;
}

/** 运行进度（完成/总数；跳过与失败不算完成）。 */
export function progressOf(steps: readonly WorkflowStepView[]): { done: number; total: number } {
  return { done: steps.filter((s) => s.status === "done").length, total: steps.length };
}

/** 续跑命令（界面只展示，不执行）。 */
export function resumeCommand(runId: string, dir: string): string {
  return `ding workflow run --resume "${dir}/runs/${runId}.json"`;
}

/**
 * **时间线条**（G10）：每个步骤在整段运行里占的那一段。
 *
 * 泳道回答"谁依赖谁"，时间线回答"时间花在哪、有没有并行、卡在哪一步"。
 * 两者都要：只有泳道看不出"两步写的是并行、其实整整串了 10 分钟"。
 *
 * 口径：
 * - 起止只认**真时间戳**（`startedAt` / `finishedAt`）；没跑过的步骤不进时间线
 *   （把它们画成 0 宽会让人以为"瞬间完成"）；
 * - 正在跑的步骤右端用 `now`（界面每秒重算一次，条会自己长）；
 * - 原点取 `min(步骤开始, 运行创建时间)`，终点取 `max(结束, 运行更新时间, 正在跑的 now)`；
 * - 宽度下限 0.6%：极短的一步也要看得见（否则"跑了但太快"会被读成"没跑"）。
 */

export type TimelineSegment = {
  id: string;
  agent: string;
  status: WorkflowStepView["status"];
  /** 左端百分比（0–100）。 */
  leftPct: number;
  /** 宽度百分比（≥0.6）。 */
  widthPct: number;
  startedAt: number;
  /** 结束时刻（正在跑 = `now`）。 */
  endedAt: number;
  durationMs: number;
  /** 正在跑（右端随时间增长）。 */
  live: boolean;
};

export type Timeline = {
  start: number;
  end: number;
  spanMs: number;
  segments: TimelineSegment[];
};

/** 把毫秒说成人话（与界面其它地方同一口径：不到 1 秒说 ms，不到 1 分钟说秒）。 */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "0ms";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  return `${m}m${s ? `${s}s` : ""}`;
}

/**
 * 算一段时间线。
 *
 * @param run 运行（至少要 `steps`；`createdAt` / `updatedAt` 用来兜住原点与终点）
 * @param now 现在（正在跑的步骤用它当右端）
 * @returns 没有任何步骤开始时给 null（界面据此不画那一条）
 */
export function timelineOf(
  run: { createdAt?: number; updatedAt?: number; steps: readonly WorkflowStepView[] },
  now: number = Date.now(),
): Timeline | null {
  const started = run.steps.filter((s) => typeof s.startedAt === "number" && s.startedAt > 0);
  if (!started.length) return null;

  const start = Math.min(...started.map((s) => s.startedAt!), ...(run.createdAt && run.createdAt > 0 ? [run.createdAt] : []));
  const ends = started.map((s) => {
    if (typeof s.finishedAt === "number" && s.finishedAt > 0) return s.finishedAt;
    return s.status === "running" ? now : s.startedAt!;
  });
  const end = Math.max(...ends, run.updatedAt && run.updatedAt > 0 ? run.updatedAt : 0, ...(started.some((s) => s.status === "running") ? [now] : []));
  const spanMs = Math.max(1, end - start);

  const segments = started.map((s) => {
    const live = s.status === "running" && !(typeof s.finishedAt === "number" && s.finishedAt > 0);
    const endedAt = live ? now : (s.finishedAt && s.finishedAt > 0 ? s.finishedAt : s.startedAt!);
    const leftPct = Math.max(0, Math.min(100, ((s.startedAt! - start) / spanMs) * 100));
    const rawWidth = ((endedAt - s.startedAt!) / spanMs) * 100;
    return {
      id: s.id,
      agent: s.agent,
      status: s.status,
      leftPct,
      widthPct: Math.max(0.6, Math.min(100 - leftPct, rawWidth)),
      startedAt: s.startedAt!,
      endedAt,
      durationMs: Math.max(0, endedAt - s.startedAt!),
      live,
    };
  });

  return { start, end, spanMs, segments };
}
