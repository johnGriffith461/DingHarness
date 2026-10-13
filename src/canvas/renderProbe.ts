/**
 * 画布渲染计数探针（2026-10-14）。
 *
 * **为什么要有这东西**：优化画布前得先知道"一次拖动到底引起多少次重渲染"，
 * 不然加 `memo` 就是凭感觉。React 自己的 DevTools profiler 在打包后的应用里
 * 没有钩子可用（`__REACT_DEVTOOLS_GLOBAL_HOOK__` 只在装了扩展时才有），
 * 所以这里自己数：每个关心的组件在渲染函数体开头调一次 `bump(名字)`。
 *
 * **为什么留在产物里**：验收跑的就是打包产物 —— 探针只活在开发构建里就等于
 * "能测的版本和发出去的版本不是同一个"。关掉时成本是一次属性读取。
 *
 * 开关由外面（机器人/手工）在页面里置位：
 * ```js
 * window.__renderProbe = true;   // 置位后开始计数
 * window.__renders               // { CanvasRuntime: 42, ... }
 * ```
 */
declare global {
  interface Window {
    __renderProbe?: boolean;
    __renders?: Record<string, number>;
  }
}

export function bump(name: string): void {
  if (typeof window === "undefined" || !window.__renderProbe) return;
  const box = (window.__renders ??= {});
  box[name] = (box[name] ?? 0) + 1;
}
