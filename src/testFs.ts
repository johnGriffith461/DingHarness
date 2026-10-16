import { rmSync } from "node:fs";

/**
 * 测试收尾用的"删得干净"（2026-10-16，审计 G55）。
 *
 * ## 它挡的是什么
 *
 * 各处收尾原来都是裸 `rmSync(dir, { recursive: true, force: true })` ——
 * `force` 只吞 **ENOENT**：Windows 上"句柄还没放"（EPERM / EBUSY）会**抛**，
 * 而 afterEach 抛错会**把下一条测试也判红**（实测形态：单跑绿、连着跑红）。
 * 更细的一层是 `EISDIR`：有的用例会在临时目录里建子目录，不加 `recursive` 就报它。
 *
 * 这里的口径：重试几次（句柄通常几十毫秒内就放），仍不行就**如实打一行警告**并返回 ——
 * 收尾失败不该把别人的用例拖红（临时目录留在系统 temp 里，下次开机自己会被清）。
 *
 * @param target 要删的路径
 */
export function removeAll(target: string): void {
  const tolerated = new Set(["ENOENT", "EISDIR", "EPERM", "EBUSY", "ENOTEMPTY"]);
  let last: unknown = null;
  for (let i = 0; i < 5; i += 1) {
    try {
      rmSync(target, { recursive: true, force: true });
      return;
    } catch (error) {
      last = error;
      const code = (error as NodeJS.ErrnoException).code;
      if (!code || !tolerated.has(code)) throw error;
      /* 等一会儿再试（同步小睡：Atomics.wait 在 Node 主线程可用） */
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 40);
    }
  }
  console.warn(`[test-cleanup] 删不掉 ${target}（${String((last as Error)?.message ?? last)}）—— 留在临时目录里，不影响判定`);
}
