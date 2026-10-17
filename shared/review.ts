/**
 * **审阅相关的跨进程形状**（U08，2026-10-18）。
 *
 * 从 `shared/ipc.ts` 抽出来的：那个文件顶着结构守卫的 900 行上限，
 * 而这两组类型（权限规则 + 逐文件改动）都是**纯线路形状**，没有行为。
 * `ipc.ts` 里仍然 re-export（既有的 import 一律不变）。
 */

/**
 * **权限规则的跨进程形状**（U03，2026-10-18）。
 *
 * ⚠️ 为什么在 `shared` 里另写一份而不是 import `engine/core/permissionRules`：
 * 分层规矩是 `shared` 不 import `engine`（那是内核，shared 是更底层的契约）。
 * 这一个类型是**线路形状**，而"哪条规则算数"的收窄实现仍然只有 engine 那一份
 * （主进程读回来就交给 `normalizeRules`）。
 */
export type PermissionRuleWire = {
  action: string;
  resource?: string;
  effect: "allow" | "deny" | "ask";
  expiresAt?: number;
  note?: string;
};

/** 一条文件改动（审阅面板与回滚都只依赖这里记下的原文）。 */
export type ReviewChangeWire = {
  toolCallId: string;
  tool: "write_file" | "edit_file";
  path: string;
  line: string;
  before?: string;
  after?: string;
  reversible: boolean;
  why?: string;
};

/** `review.list` 的成功载荷。 */
export type ReviewListResult =
  | {
      ok: true;
      summary: { files: number; edits: number; writes: number; reversible: number };
      files: Array<{ path: string; changes: ReviewChangeWire[] }>;
    }
  | { ok: false; error: string };

/** `review.revert` 的结果。 */
export type ReviewRevertResult = { ok: true; reverted: number } | { ok: false; error: string };
