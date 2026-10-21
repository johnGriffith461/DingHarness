import { resolveCapability, sourceLabel, type DeclaredCapability, type EndpointModelInfo, type ResolvedCapability } from "@engine/runtime/modelCapability";

/**
 * **模型表单的预填**（M-04）：选中模型后带出窗口/输出/模态/思考，来源可见。
 *
 * 逻辑只有一份 —— 这里只是给渲染层一个语义更直白的入口，
 * 真正的优先级在 `engine/runtime/modelCapability.ts`（CLI 也用同一份）。
 */

export type Prefill = ResolvedCapability & { label: string };

/**
 * @param providerId 该模型属于哪家（目录匹配的第一级）
 * @param modelId 模型 id（还没填完时返回 null）
 * @param fetched 端点 `/models` 自报的能力（没有就 undefined）
 * @param declared 用户已有的声明（编辑态传；新增时 undefined）
 * @param edited 用户已经手动改过（覆盖"来源"文案）
 */
export function prefillFor(
  providerId: string,
  modelId: string,
  fetched?: EndpointModelInfo,
  declared?: DeclaredCapability,
  edited = false,
): Prefill | null {
  const id = String(modelId ?? "").trim();
  if (!id) return null;
  const resolved = resolveCapability({ providerId, modelId: id, ...(fetched ? { fetched } : {}), ...(declared ? { declared } : {}) });
  return { ...resolved, label: sourceLabel(resolved.source, edited ? { edited: true } : {}) };
}
