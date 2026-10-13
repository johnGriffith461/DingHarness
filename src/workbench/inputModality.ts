/**
 * 输入模态标记（2026-10-14）。
 *
 * ## 为什么需要它
 * 主人两次点名"雷霆大描边"：一进输入区，整圈边框就亮了。
 *
 * 按理该用 `:focus-visible` 区分"键盘来的"和"鼠标点进来的"，但**文本输入框不适用**：
 * 浏览器规定 `input` / `textarea` 被**鼠标**点中时**也算 `:focus-visible`**
 * （因为光标在那儿、用户需要看得见）。所以 `:has(:focus-visible)` 也救不了
 * —— 我试过，鼠标点进去照样匹配。
 *
 * 于是把"**这一次交互是键盘还是鼠标**"这件事显式记在 `<html data-kb>` 上：
 *   · 键盘 Tab → 置位 → 焦点反馈生效（键盘用户没有它就是不知道焦点在哪）
 *   · 鼠标按下 → 清掉 → 一动不动（用户自己知道刚点了哪儿）
 *
 * 这不是什么黑魔法，浏览器做不到区分时，就只有把用户的操作方式记下来这一条路；
 * 代价是 `<html>` 上一个属性与两个全局监听（capture 阶段，不拦事件）。
 *
 * ⚠️ 只在**挂载时装一次**（`install()` 幂等）。
 */

const ATTR = "data-kb";

/** 装一次；重复调用直接返回。 */
export function installInputModality(): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  if (root.dataset.modalityInstalled === "1") return;
  root.dataset.modalityInstalled = "1";

  document.addEventListener(
    "keydown",
    (e: KeyboardEvent) => {
      /*
       * 只认"键盘在导航"的按键：Tab 与方向键。
       * 打字（字母/中文）**不算** —— 不然"鼠标点进来然后打了几个字"
       * 又会被算成键盘用户，边框照样亮起来，主人看到的还是那个描边。
       */
      if (e.key === "Tab" || e.key.startsWith("Arrow")) root.setAttribute(ATTR, "1");
    },
    true,
  );

  document.addEventListener(
    "mousedown",
    () => {
      root.removeAttribute(ATTR);
    },
    true,
  );
  /* 触摸同理：手指点哪儿自己看得见，不需要再描一圈 */
  document.addEventListener(
    "touchstart",
    () => {
      root.removeAttribute(ATTR);
    },
    { capture: true, passive: true },
  );
}
