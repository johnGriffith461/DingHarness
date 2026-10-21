import { useEffect } from "react";

/**
 * **点输入框就收掉弹层与「更多」展开态**（2026-10-22，主人报的）。
 *
 * 原话：「点击主页对话框里边的插件按钮 我再点击对话框 这个按钮它关不掉，
 * 必须手动再摁一下这个插件按钮才行。还有更换模型按钮那也是」。
 *
 * ## 判据只认一件事：点的是输入框
 *
 * 走过的两次弯路都记在这儿，免得下一个人再踩：
 *   ① 第一版"不在 `.wb-chip-wrap` 里就关" —— 技能/命令面板是 portal，落在 body 上，
 *      点面板内部被判成"外面"，面板一点就自己关掉；
 *   ② 第二版"composer 内部都放过" —— portal 里的面板不在 composer 内，
 *      点完命令面板顺带把「更多」展开态也收了，后面点项目 chip 直接超时。
 *
 * @param active 现在有东西可关吗（没有就不挂监听）
 * @param close 收掉它们
 */
export function useComposerDismiss(active: boolean, close: () => void): void {
  useEffect(() => {
    if (!active) return;
    const onDown = (event: MouseEvent): void => {
      const target = event.target as HTMLElement | null;
      if (!target) return;
      if (!target.closest('[data-testid="wb-composer-input"]')) return;
      close();
    };
    document.addEventListener("mousedown", onDown, true);
    return () => document.removeEventListener("mousedown", onDown, true);
  }, [active, close]);
}
