/**
 * 「提到的文件」这条链上的类型（2026-10-14）。
 *
 * 拆出来是因为 `fileContext.ts` 要在 `node` 环境下被单测直接跑，
 * 而它的类型此前想从 preload 的 `ShellBridge` 里取 —— 那会把整个 IPC 契约
 * 拖进测试的依赖图里（一个纯字符串函数不需要知道 electron 长什么样）。
 */

/** 一个路径的读取结果。`text` 为 `null` 表示没读到（原因见 `fileContext.ts` 的说明）。 */
export type PathRead = {
  /** 用户原话里出现的那个路径（原样保留，界面与日志里对齐用）。 */
  path: string;
  /** 文件内容；`null` = 读不到。 */
  text: string | null;
};
