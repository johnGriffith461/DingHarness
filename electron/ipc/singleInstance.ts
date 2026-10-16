/**
 * 单实例锁（**审计 P39**）。
 *
 * ## 缺陷形状
 *
 * 整改前全仓没有 `requestSingleInstanceLock`：双击图标两次、或安装包与「从文件夹打开」
 * 各起一次，就有**两个进程**并发写同一份 `stores.db` / `sessions.db` / 一批 JSON ——
 * 没有 WAL、没有 `busy_timeout` 的裸 SQLite 连接撞在一起，写侧 `SQLITE_BUSY`，
 * 上层回落到文件，于是出现同一份数据两个版本（split-brain）。
 *
 * ## 为什么抽成一份可测的
 *
 * `app.requestSingleInstanceLock()` 的返回值语义很硬：**false 就必须尽快退出**，
 * 否则两个实例都会去建窗口、注册 IPC。这条"拿到锁才继续"的分支值得被真断言，
 * 而不是散在 `main.ts` 顶层语句里（那里测不到）。所以收成一个纯函数，
 * `src/electronGuards.test.ts` 用假 `app` 直接验两条分支。
 */

/** 只要这两件事的 app 形状（真实 `Electron.App` 结构上满足）。 */
export type SingleInstanceApp = {
  /** 抢主实例锁；false = 已有实例在跑。 */
  requestSingleInstanceLock: () => boolean;
  /** 挂「第二个实例来了」的回调。 */
  on: (event: "second-instance", listener: () => void) => unknown;
};

/**
 * 抢主实例锁。
 *
 * @param app Electron 的 app（或同形状的假对象）
 * @param onSecondInstance 第二个实例被拉起时要做的事（通常是把已有窗口亮出来）
 * @returns 拿到锁 true（可以继续建窗口）；没拿到 false（调用方必须退出）
 */
export function ensureSingleInstance(app: SingleInstanceApp, onSecondInstance: () => void): boolean {
  if (!app.requestSingleInstanceLock()) return false;
  app.on("second-instance", onSecondInstance);
  return true;
}
