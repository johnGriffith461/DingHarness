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
 * ## 2026-10-20 修掉的竞态
 *
 * 旧实现是"一个 Promise 闸"：`waitCanvasLoaded()` 抓住**当时**那个 Promise，
 * 而命令先到、画布后挂载 —— 挂载时 `resetCanvasLoadGate()` 把 Promise 换掉，
 * 等待方抱着旧那个**永远等不到**（实测：画布已经显示 6 个节点，15 秒后仍报"没载入完"）。
 *
 * 现在改成"等待者列表 + loaded 标记"：
 * - `waitCanvasLoaded` 把 resolver 放进列表，**不绑定某一代 Promise**；
 * - `markCanvasLoaded()` 把当前所有等待者一起放行；
 * - `resetCanvasLoadGate()` 只清 loaded 标记，**不清等待者** ——
 *   它们等的是"接下来那次载入"，而 reset 正是那次载入的开始。
 *
 * 想保证"等的是新一次载入"的调用方（命令宿主在打开画布前）**先 reset 再 wait**，
 * 见 `canvasCommandHost.ts`。
 */

let loaded = false;
let waiters: Array<() => void> = [];

/** 重开一次闸（画布挂载/命令打开画布前调）：之后的等待必须等新的 mark。 */
export function resetCanvasLoadGate(): void {
  loaded = false;
}

/** 放行（载入成功、失败、或根本没有画布桥时都要调，别让等待方白等）。 */
export function markCanvasLoaded(): void {
  loaded = true;
  const pending = waiters;
  waiters = [];
  for (const resolve of pending) resolve();
}

/**
 * 等画布载入完成。
 *
 * @param timeoutMs 最多等多久（主进程那条命令只有 20 秒，这里必须明显短于它，
 *                  否则回执会变成"主进程超时"这种看不出原因的失败）
 * @returns true = 载入已完成；false = 等到超时都没完成（调用方负责如实回执）
 */
export async function waitCanvasLoaded(timeoutMs: number): Promise<boolean> {
  if (loaded) return true;
  const settled = new Promise<boolean>((resolve) => {
    waiters.push(() => resolve(true));
  });
  const timeout = new Promise<boolean>((resolve) => {
    setTimeout(() => resolve(false), timeoutMs);
  });
  return Promise.race([settled, timeout]);
}
