/**
 * 画布文档与快照的共享类型（主进程写盘、渲染进程读写都引这里）。
 *
 * 一份画布 = 版本号 + 单调修订号 + 视口 + 节点 + 边。
 * 节点/边的具体结构由渲染进程的 `src/canvas/types.ts` 定义，这里只保证
 * "能被 JSON 序列化"这一条（画布图必须可序列化，否则宁可显式报错）。
 */

export type CanvasViewport = { x: number; y: number; zoom: number };

export type CanvasDocument = {
  /** 文档格式版本；结构变了才 +1。 */
  version: number;
  /** 单调递增修订号（对标原版 `documentRevision`）。 */
  revision: number;
  /** 已被确认落盘的修订号（对标原版 ack）。 */
  confirmedRevision: number;
  /** 最后写入时间（ISO）。 */
  updatedAt?: string;
  viewport: CanvasViewport;
  nodes: unknown[];
  edges: unknown[];
  /** 标记层（阶段 5）。文档 version 2 起有这一项。 */
  markers?: unknown[];
};

/** 快照状态摘要。 */
export type CanvasSnapshotFile = {
  revision: number;
  confirmed: boolean;
  updatedAt: string | null;
  dir: string;
};

/** 载入结果。 */
export type CanvasLoadResult = {
  doc: CanvasDocument;
  recovered: boolean;
  recoveryNote?: string;
};

/** 保存结果。 */
export type CanvasSaveResult = { ok: true; savedAt: string } | { ok: false; error: string };
