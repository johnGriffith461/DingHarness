/**
 * 模型页的**纯布局逻辑**（M-01）。
 *
 * 两件事写成纯函数，单测与界面读同一份：
 * - 左列搜索：大小写不敏感，匹配 id 与显示名；
 * - 模型清单按家族分组：顺序稳定，不随数据顺序乱跳。
 */

/** 家族判定：顺序即分组顺序。 */
const FAMILIES = ["deepseek", "gpt", "claude", "gemini", "qwen", "其它"] as const;
export type ModelFamily = (typeof FAMILIES)[number];

/** 一条模型属于哪个家族（只看 id，不看 provider —— 同一家族可能来自不同中转）。 */
export function familyOf(modelId: string): ModelFamily {
  const id = modelId.toLowerCase();
  if (id.includes("deepseek")) return "deepseek";
  /* gpt-* 与 o1/o3/o4 这类推理模型都算 OpenAI 家族 */
  if (/(^|\/)gpt-/.test(id) || /(^|\/)o\d/.test(id)) return "gpt";
  if (id.includes("claude")) return "claude";
  if (id.includes("gemini")) return "gemini";
  if (id.includes("qwen")) return "qwen";
  return "其它";
}

/**
 * 按家族分组（组内保持输入顺序；空组不出现）。
 *
 * 家族顺序固定（`FAMILIES` 的次序），所以"刷新一次模型清单"不会让分组乱跳。
 */
export function groupByFamily(models: readonly string[]): Array<{ family: ModelFamily; models: string[] }> {
  const buckets = new Map<ModelFamily, string[]>();
  for (const model of models) {
    const family = familyOf(model);
    const list = buckets.get(family) ?? [];
    list.push(model);
    buckets.set(family, list);
  }
  return FAMILIES.flatMap((family) => {
    const got = buckets.get(family);
    return got && got.length ? [{ family, models: got }] : [];
  });
}

/** 左列搜索：大小写不敏感，匹配 id 与显示名。空查询返回原列表（不复制对象）。 */
export function filterProviders<T extends { id: string; label: string }>(list: readonly T[], query: string): T[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...list];
  return list.filter((p) => p.id.toLowerCase().includes(q) || p.label.toLowerCase().includes(q));
}
