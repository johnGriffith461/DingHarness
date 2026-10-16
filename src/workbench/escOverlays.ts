/**
 * Esc 的「浮层让路」名单（2026-10-16 审计 P107）。
 *
 * ## 原来错在哪
 *
 * `Workbench` 里那段 Esc 处理只认一个 `.wb-modal-mask`，注释写着"弹窗开着时不动面板"。
 * 但仓里的浮层**远不止弹窗**：
 *   · 技能面板 `.wb-cmd-panel`（`SkillPanel.tsx`）
 *   · 右键菜单 `.wb-ctx`（`ContextMenu.tsx`）
 *   · 账号菜单 `.wb-acct-menu`（`AccountMenu.tsx`，testid `wb-account-menu`）
 *   · 画布节点右键菜单 `.cv-ctx`（`NodeContextMenu.tsx`）
 *   
 * 这些组件**各自也在 keydown 上 `onClose()`** —— 于是按一次 Esc 会**同时**发生两件事：
 * 关掉那个浮层 **和** 收起右侧摘要面板。用户的意思明显是"先关我刚点开的那个"，
 * 而结果是"两个一起没了"，还得再点一次把摘要面板展开。
 *
 * ⚠️ 名单里还留着 `.wb-modal-mask`：它本身已经是**死选择器**（整页化的设置不再用它），
 * 但"将来真加了模态遮罩要有让路"这条口径仍然成立，所以保留并在这里说明。
 * 真正需要它让路的是**设置整页** `.wb-setfull`（`SettingsDialog.tsx`）——
 * 它自己处理 Esc（P108），不该顺带把背后的面板也收掉。
 *
 * ## 为什么是把选择器抽出来
 *
 * 名单与判定都在这一个文件里，测试可以**直接断言名单**（而不是在 Workbench 里
 * 正则找字符串）—— 这也是本仓"一处实现"的既有做法。
 */

/** 开着这些浮层时，Workbench 的 Esc **不动**右侧面板（让它们自己处理）。 */
export const ESC_YIELDS_SELECTORS = [
  /** 旧的模态遮罩（「设置」整页化之前的东西；保留是防将来真加回模态）。 */
  ".wb-modal-mask",
  /** 设置整页（它自己处理 Esc，见 SettingsDialog.tsx）。 */
  ".wb-setfull",
  /** 技能面板。 */
  ".wb-cmd-panel",
  /** 通用右键菜单。 */
  ".wb-ctx",
  /** 账号菜单。 */
  ".wb-acct-menu",
  /** 画布节点右键菜单。 */
  ".cv-ctx",
] as const;

/**
 * 现在有浮层占着键盘吗。
 *
 * @param exists 判断某个选择器在不在（浏览器里就是 `document.querySelector`)
 * @returns true = 该让路
 */
export function escYieldsToOverlay(exists: (selector: string) => boolean): boolean {
  return ESC_YIELDS_SELECTORS.some((selector) => exists(selector));
}
