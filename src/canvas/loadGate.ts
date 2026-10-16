/**
 * 画布载入闸（2026-10-16，审计 P74）。
 *
 * ## 它挡的是什么
 *
 * 「AI 往画布加节点」这条命令由主进程发过来（`canvasCommandHost.ts`），
 * 而画布文档是**渲染进程**持有的：命令到达时如果画布还没开，宿主先 `toggleCanvas()`
 * 打开它 —— 但载入是**异步**的（`usePersistence` 那个 effect 里 `await shell.canvas.load()`），
 * 宿主原来只能 `await sleep(400)` 赌一把。赌输的后果不是"慢一点"：
 * 载入回来时会 `loadDocument()` **整块覆盖**画布，那个刚建好的节点被冲掉，
 * 而宿主照样回执 `ok:true`（工具以为自己干成了）。
 *
 * ## 为什么做成模块级的闸
 *
 * 载入完成的那一刻只有一个来源（`usePersistence`），而等待方在**另一个模块**里。
 * 做成 Promise 闸之后就是"等一件真事"，而不是等一个猜出来的毫秒数。
 *
 * ⚠️ 每次画布挂载都要 `resetCanvasLoadGate()`：否则"上次挂载已经载入完"这件事
 * 会让这一次的等待**立刻**放行 —— 那就又变回赌了。
 */

let resolveCurrent: (() => void) | null = null;
let gate: Promise<void> = new Promise((resolve) => {
  resolveCurrent = resolve;
});

/**
 * 重开一次闸（画布挂载时调）。
 *
 * 已经等着的那些等待者会**一直等下去** —— 这是对的：它们等的是"那次挂载的载入"，
 * 而那次挂载已经被换掉了（画布关闭再打开），旧的那一份不该再被唤醒。
 */
export function resetCanvasLoadGate(): void {
  gate = new Promise<void>((resolve) => {
    resolveCurrent = resolve;
  });
}

/** 放行（载入成功、失败、或根本没有画布桥时都要调，别让等待方白等）。 */
export function markCanvasLoaded(): void {
  const done = resolveCurrent;
  resolveCurrent = null;
  done?.();
}

/**
 * 等画布载入完成。
 *
 * @param timeoutMs 最多等多久（主进程那条命令只有 5 秒，这里必须明显短于它，
 *                  否则回执会变成"主进程超时"这种看不出原因的失败）
 * @returns true = 载入已完成；false = 等到超时都没完成（调用方负责如实回执）
 */
export async function waitCanvasLoaded(timeoutMs: number): Promise<boolean> {
  const settled = gate.then(() => true);
  const timeout = new Promise<boolean>((resolve) => {
    setTimeout(() => resolve(false), timeoutMs);
  });
  return Promise.race([settled, timeout]);
}
