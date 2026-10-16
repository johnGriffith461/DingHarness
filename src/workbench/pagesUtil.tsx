/**
 * 从 `pages.tsx` 拆出来的（C6-2）。**纯挪位**：一个字没改，只加了 export 与 import。
 * 拆分理由原本记在 `docs/PLAN-C6-结构拆分.md`（那个文件 1669 行 / 7 个顶层组件）。
 * ⚠️（该依据未入库、本机也找不到 —— 决策链断在这里，无法复核；以本文件里的断言与实现为准）
 */

export function ChevronRight() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="m9 18 6-6-6-6" />
    </svg>
  );
}

/**
 * 一个插件/技能条目。
 *
 * 两个按钮的含义是分开的：**安装**是把条目拿到本机，**启用**是这次任务里要不要用它。
 * 不分开的话，"装了但这次不想用"就没法表达。
 */
