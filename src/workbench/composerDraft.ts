/**
 * 输入区草稿的**归属键**（2026-10-16，审计 P84）。
 *
 * ## 为什么需要它
 *
 * 草稿原来长在 `Composer` 的组件 state 里，而 `Workbench` 按 view **整体换组件** ——
 * 在输入框里写着东西、按 Ctrl+N（或点左栏）切个页，回来一看**整段话没了**。
 * 草稿搬进 store 之后，"哪一份草稿"要有一个稳定的键：**按视图分**，
 * 而且**每段对话各自一份**（在 A 对话里写的半句话，不该出现在 B 对话的输入框里）。
 *
 * 纯函数放在这里是为了能单独测：组件那一层在这个仓里没有渲染环境。
 */

/**
 * 算出这份草稿属于谁。
 *
 * 规则：
 *   · 对话视图（`view === "task"`）按**任务 id** 分 —— 换一段对话就是另一份草稿；
 *   · 其它视图按 view 名分（首页一份、定时任务页一份…）；
 *   · 对话视图但还没有任务 id 时退回 `"task"` 这一份（免得出现 `task:null` 这种键）。
 *
 * @param view 当前视图
 * @param activeTaskId 当前任务 id（没有就是 null）
 * @returns 草稿键（同一个人回来必然拿到同一串）
 */
export function draftKeyOf(view: string, activeTaskId: string | null | undefined): string {
  if (view === "task") return activeTaskId ? `task:${activeTaskId}` : "task";
  return view;
}
