/**
 * 注册隔离（**审计 P45**）。
 *
 * ## 缺陷形状
 *
 * `main.ts` 把二十来个模块的 `registerXxxIpc()` 塞进三个大 `try` 里。
 * 大块内**任一**个抛错，它后面那一串注册全部被跳过 —— 打包态没有控制台，
 * 表现是"某个页面整个失联"，而原因只在一行 `console.error` 里。
 *
 * 所以改成**一个模块一层 try**：坏的那个只丢它自己，其余照常注册；
 * 失败同时进 `boot.log`（打包后唯一拿得到的现场）。
 */

/** 失败时怎么留话（`main.ts` 传 `bootLog` + `console.error`）。 */
export type RegisterFailureLogger = (message: string) => void;

/**
 * 跑一个注册动作，把它自己的异常关在它自己身上。
 *
 * @param label 模块名（进日志，坏了好定位）
 * @param register 真正注册的动作
 * @param onError 失败时怎么留话
 * @returns 成功 true；抛错被吞掉 false（**吞的是隔离，不是静默**：话一定留了）
 */
export function safeRegister(label: string, register: () => void, onError: RegisterFailureLogger): boolean {
  try {
    register();
    return true;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    onError(`[${label}] 注册失败：${reason} —— 该模块的通道这次不可用，其余模块照常注册`);
    return false;
  }
}
