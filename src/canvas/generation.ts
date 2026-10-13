import type { CanvasNodeData } from "./types";

/**
 * 生成版本与状态（PLAN 3.4 / 3.5，对标原版 `data-canvas-generation-version` 与
 * `data-canvas-generation-state`）。
 *
 * 模型是"节点内容可迭代"：每次重新生成都往 `versions` 里追加一版，
 * `activeVersion` 指向当前展示的那一版，老版本随时可以切回来。
 * `generation.contentKeys` 记下"内容存在哪些字段里"，所以还原某一版时
 * 不用为每种节点类型写一套分支 —— 只需把这几个字段写回。
 */

/**
 * 生成逻辑需要的最小节点形状。
 *
 * 刻意不用 `CanvasNode`（那个联合太重，节点渲染器里手工拼一个完整节点会很难受）；
 * 生成只关心"哪一类节点 + 它的 data"，用这个就够了。
 */
export type GenerationNode = {
  id: string;
  type: string;
  data: Record<string, unknown>;
};
export type GenerationStatus = "idle" | "generating" | "done" | "failed";

export type GenerationVersion = {
  id: string;
  createdAt: number;
  /** 这一版是哪个模型 / 谁产出的（手工编辑记 `manual`）。 */
  model: string;
  /** 该版的内容快照（只含内容字段）。 */
  content: Record<string, unknown>;
};

export type GenerationMeta = {
  /** 内容字段名（如 markdown 节点是 `["text"]`）。 */
  contentKeys: readonly string[];
  status: GenerationStatus;
  /** 最近一次失败原因。 */
  error?: string;
  /** 触发这一版的提示词（便于"再来一次"）。 */
  prompt?: string;
  versions: GenerationVersion[];
  activeVersion: string;
};

/** 带生成信息的节点数据。 */
export type Generative<T extends Record<string, unknown>> = T & {
  generation?: GenerationMeta;
};

/** 每种节点类型的内容字段（决定"哪部分内容属于可迭代产物"）。 */
export const CONTENT_KEYS: Record<string, readonly string[]> = {
  markdown: ["text"],
  code: ["code", "lang"],
  mermaid: ["code"],
  mindmap: ["markdown"],
  image: ["src", "alt"],
  whiteboard: ["strokes"],
};

/** 从节点 data 里抽出内容字段。 */
export function extractContent(node: GenerationNode): Record<string, unknown> {
  const keys = CONTENT_KEYS[node.type] ?? [];
  const out: Record<string, unknown> = {};
  for (const key of keys) {
    if (node.data[key] !== undefined) out[key] = node.data[key];
  }
  return out;
}

let versionSeq = 0;

/** 生成一个版本 id。 */
export function nextVersionId(): string {
  versionSeq += 1;
  return `v-${Date.now()}-${versionSeq}`;
}

/** 首版生成信息（节点刚被创建/生成出来时用）。 */
export function seedGeneration(
  node: GenerationNode,
  model: string,
  extra: { prompt?: string; status?: GenerationStatus } = {},
): GenerationMeta {
  const version: GenerationVersion = {
    id: nextVersionId(),
    createdAt: Date.now(),
    model,
    content: extractContent(node),
  };
  return {
    contentKeys: CONTENT_KEYS[node.type] ?? [],
    status: extra.status ?? "done",
    prompt: extra.prompt,
    versions: [version],
    activeVersion: version.id,
  };
}

/**
 * 追加一个新版本并设为当前版。
 * @param node 目标节点（用来抽内容）
 * @param model 产出这一版的模型名（手工编辑传 `manual`）
 */
export function appendVersion(node: GenerationNode, model: string): GenerationMeta {
  const prev = readMeta(node);
  const version: GenerationVersion = {
    id: nextVersionId(),
    createdAt: Date.now(),
    model,
    content: extractContent(node),
  };
  const versions = [...(prev?.versions ?? []), version];
  return {
    contentKeys: CONTENT_KEYS[node.type] ?? [],
    status: "done",
    prompt: prev?.prompt,
    versions,
    activeVersion: version.id,
  };
}

/** 读节点上的生成信息。 */
export function readMeta(node: { data: Record<string, unknown> }): GenerationMeta | undefined {
  return node.data["generation"] as GenerationMeta | undefined;
}

/** 把某一版的内容还原成可写回 data 的补丁。 */
export function versionPatch(node: { data: Record<string, unknown> }, versionId: string): Record<string, unknown> | null {
  const meta = readMeta(node);
  const version = meta?.versions.find((v) => v.id === versionId);
  return version ? { ...version.content } : null;
}

/** 版本在列表里的序号（从 1 开始，给界面显示用）。 */
export function versionIndex(node: { data: Record<string, unknown> }, versionId: string): number {
  const meta = readMeta(node);
  if (!meta) return 0;
  return meta.versions.findIndex((v) => v.id === versionId) + 1;
}

/** 把生成信息写回节点 data 的补丁。 */
export function generationPatch(meta: GenerationMeta): { generation: GenerationMeta } {
  return { generation: meta };
}

/** 清理节点 data 上的生成信息（给"固化"用，可选）。 */
export function stripGeneration(data: CanvasNodeData): CanvasNodeData {
  const copy = { ...(data as unknown as Record<string, unknown>) };
  delete copy["generation"];
  return copy as unknown as CanvasNodeData;
}
