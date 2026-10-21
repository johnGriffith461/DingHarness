/**
 * **「添加/编辑模型」表单的字段顺序与可见性**（M-04）。
 *
 * 主人给的顺序是死的：**模型 → 最大上下文 → 最大输出 → 输入类型 → 思考强度**。
 * 把它写成数据，验收脚本与单测都断言同一份顺序 —— 而不是让后人改 JSX 时"看起来差不多"。
 *
 * 思考强度那一行在模型 `reasoning=false` 时**整行隐藏**（不是禁用）：
 * 一个不支持思考的模型旁边摆一排不能点的档位，只会让用户以为界面坏了。
 */

export const MODEL_FORM_FIELDS = ["model", "contextWindow", "maxOutput", "inputModalities", "reasoningEffort"] as const;

export type ModelFormField = (typeof MODEL_FORM_FIELDS)[number];

/** 表单字段顺序（返回新数组，调用方改它不污染常量）。 */
export function modelFormOrder(): ModelFormField[] {
  return [...MODEL_FORM_FIELDS];
}

/** 思考强度这一行要不要出现。 */
export function reasoningRowVisible(cap: { reasoning?: boolean } | undefined | null): boolean {
  return cap?.reasoning === true;
}
