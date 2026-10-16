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
       * 只认**Tab 在导航**（2026-10-16 审计 P275）。
       *
       * 原来这里是 `e.key === "Tab" || e.key.startsWith("Arrow")`。而方向键在输入区里
       * **有实义**（历史/选单导航、光标移动）：用户鼠标点进输入框（mousedown 已经把
       * 属性清掉）之后按一下 ↑，属性又被置上 —— 文件头点名两次的「雷霆大描边」
       * 就这样亮了回来。注释自己的口径是"只有键盘在导航才算"，而 Tab 才是那个信号。
       *
       * （打字本身也不置位：鼠标点进来再打几个字，同样不该算键盘用户。）
       */
      if (e.key === "Tab") root.setAttribute(ATTR, "1");
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
