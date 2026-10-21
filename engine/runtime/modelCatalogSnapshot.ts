import raw from "./data/models.snapshot.json";

import { canonicalModelId, mergedCatalog, type CatalogEntry, type SnapshotModel } from "./modelSnapshot";

/**
 * **模型目录快照的装载点**（M-07）。
 *
 * 数据文件：`engine/runtime/data/models.snapshot.json`（由 `pnpm build:model-snapshot` 生成，**要提交**）。
 * 合并规则与口径写在 `modelSnapshot.ts` 文件头：手核条目在前，快照在后。
 *
 * 这里只做三件事：把 JSON 收窄成类型、合并、按三级规则查一条。
 */

const snapshot = raw as {
  _source?: string;
  _generatedAt?: string;
  models?: SnapshotModel[];
};

export const SNAPSHOT_SOURCE = snapshot._source ?? "（未知）";
export const SNAPSHOT_GENERATED_AT = snapshot._generatedAt ?? "（未知）";
export const MODEL_CATALOG_SNAPSHOT: SnapshotModel[] = Array.isArray(snapshot.models) ? snapshot.models : [];

/** 手核 + 快照，合成一张表。**懒合并一次**（468 条 × 每行模型 × 每次渲染会很浪费）。 */
let cache: CatalogEntry[] | null = null;

export function catalogEntries(): readonly CatalogEntry[] {
  if (!cache) cache = mergedCatalog(MODEL_CATALOG_SNAPSHOT);
  return cache;
}

/**
 * 在目录里找一条：**provider+id 精确 → id 全局唯一 → 归一化后唯一**。
 *
 * 任何一步命中多条都**不算命中**（宁可落到默认并标出来，也不猜）。
 */
export function matchCatalogEntry(providerId: string, modelId: string): CatalogEntry | undefined {
  const id = String(modelId ?? "").trim();
  if (!id) return undefined;
  const all = catalogEntries();

  const scoped = all.find((m) => m.provider === providerId && m.id === id);
  if (scoped) return scoped;

  const exact = all.filter((m) => m.id === id);
  if (exact.length === 1) return exact[0];

  const canonical = canonicalModelId(id);
  if (!canonical) return undefined;
  const near = all.filter((m) => m.canonicalId === canonical);
  return near.length === 1 ? near[0] : undefined;
}
