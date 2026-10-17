/**
 * 一条**串行队列**（2026-10-16，审计 P42）。
 *
 * ## 为什么需要它
 *
 * 记忆与定时任务都是"读出整份 → 改 → 写回整份"的形状。两次调用并发时
 * （模型在一轮里连发两条 `memory_save`、或用户点「允许」时正好又有一轮在跑），
 * 两边读到同一份旧快照，后写的把先写的整份盖掉 —— **丢一条，而且不报错**。
 *
 * 同仓的 `aiProbe.ts` 早就为这件事写过"下面的 chain —— 并发调用排队执行，
 * 不会互相覆盖"，但它是就地写的一段；抽出来是为了让**这件事实有单测能钉**
 * （原来那段只能靠读源码确认，改坏了没有任何断言会红），并且给后面的调用方
 * 一个统一口径，而不是每处各写一遍。
 *
 * 口径：**一段失败不堵住后面的人**（队尾只保留"完成"这个事实，异常的传播由
 * 各自的返回 Promise 负责）。
 */
export type SerialQueue = <T>(task: () => Promise<T>) => Promise<T>;

/**
 * **按 key 串行**的队列（U05，2026-10-18）。
 *
 * 与全局队列的区别：只有**同一个 key** 的任务互相排队，不同 key 并行。
 * 写工具用它按**目标路径**串行：模型同一轮里可能连发两条对同一个文件的写/改，
 * 交错执行会让后写的整份盖掉先写的（与 P42 同一类，只是这次按路径分）。
 *
 * 为什么不用一条全局队列：那会把"同时写两个不同文件"也串起来 ——
 * 一次重构里改十个文件就会变成十次串行的磁盘往返，而它们本来就不冲突。
 *
 * key 的归一化由调用方做（写工具那边用 `path.resolve` 之后的值）：
 * 队列只负责"同样的字符串不并发"，不做路径语义判断 —— 混进来会让这个模块
 * 依赖平台路径规则。
 */
export type KeyedSerialQueue = <T>(key: string, task: () => Promise<T>) => Promise<T>;

/** 建一条按 key 串行的队列。 */
export function createKeyedSerialQueue(): KeyedSerialQueue {
  const tails = new Map<string, Promise<unknown>>();
  return <T>(key: string, task: () => Promise<T>): Promise<T> => {
    const tail = tails.get(key) ?? Promise.resolve();
    const run = tail.then(task, task);
    /*
     * 队尾记为"完成"（无论成败）：一段坏了不该让后面同一个 key 的写永久卡住。
     * 跑完之后清掉这条 key，避免长会话里 Map 无限增长（下一个写会重新建一条）。
     */
    const settled = run.then(
      () => undefined,
      () => undefined,
    );
    tails.set(key, settled);
    void settled.finally(() => {
      if (tails.get(key) === settled) tails.delete(key);
    });
    return run;
  };
}

/**
 * 建一条串行队列。
 *
 * @returns 把任务排到队尾并返回它自己的 Promise
 */
export function createSerialQueue(): SerialQueue {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(task: () => Promise<T>): Promise<T> => {
    // 失败也要跑（第一参是成功回调，第二参是失败回调）——一段坏了不该让后面所有人卡住
    const run = tail.then(task, task);
    tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };
}
