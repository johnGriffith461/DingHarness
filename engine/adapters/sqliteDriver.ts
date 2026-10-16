import { createRequire } from "node:module";

/**
 * SQLite 驱动的**运行时选择**（Phase 11.1 的配套）。
 *
 * ## 为什么要有这一层
 *
 * 方案 11.1 有一条**前置冒烟门**：CLI 要编成单文件可执行，而 `node:sqlite` 是
 * **Node 独有**的内置模块 —— 换到 Bun runtime 就不存在了。实测确认：
 *
 * ```
 * $ bun -e 'require("node:sqlite")'
 * No such built-in module: node:sqlite
 * ```
 *
 * 而方案的处置也写好了：**经冻结端口换 `bun:sqlite` 实现**
 * （"端口冻结原则正为此设计" —— `SessionStore` 端口从 Phase 1 就没动过，
 * 换的是它底下的驱动，不是它的形状）。
 *
 * ## 这一层只做一件事：把两家的 API 抹平成同一个形状
 *
 * 两家的**同步** API 几乎一样（`exec` / `prepare().run|get|all` / `close`），
 * 差别只有类名与几个返回值细节。所以这里不引入抽象层，只做一个最小的适配：
 * 存储层拿到的永远是 `SqliteDatabase`。
 *
 * ## 选驱动的判据：**运行时**，不是编译期
 *
 * - Bun runtime（单二进制那条）：`require("bun:sqlite")`
 * - Node / Electron：`require("node:sqlite")`
 *
 * 判据是 `process.versions.bun`。**不按"编译目标"判** —— 同一份源码既跑在
 * Node（桌面与 `pnpm ding`）又跑在 Bun（单二进制），编译期区分会逼出两套产物。
 *
 * ⚠️ 用 `require` 而不是 `import`：`bun:sqlite` 在 Node 里不存在，
 * 静态 import 会让 Node 侧**加载即失败**。下面这一段在 ESM 与 CJS 下都能跑：
 * CJS 有全局 `require`，ESM（vitest / tsx）走 `createRequire`。
 */

const req: NodeRequire =
  typeof require === "function" ? require : createRequire(`${process.cwd()}/sqliteDriver.js`);

/** 一条预处理语句（两家共有的那部分）。 */
export type SqliteStatement = {
  run: (...params: unknown[]) => { changes?: number | bigint; lastInsertRowid?: number | bigint };
  get: (...params: unknown[]) => unknown;
  all: (...params: unknown[]) => unknown[];
  /**
   * 释放这条语句（可选：**两家不一样**）。
   *
   * `bun:sqlite` 的 `Statement` 有 `finalize()`，`node:sqlite` 的 `StatementSync`
   * **没有**（靠 GC 回收）。所以类型里是可选的，调用方用 `stmt.finalize?.()`。
   * 审计 P144 的要求就是"别只 prepare 不释放"：长命语句（会话库那十几条）在
   * `close()` 时逐个释放。
   */
  finalize?: () => void;
};

/** 一个同步数据库句柄（两家共有的那部分）。 */
export type SqliteDatabase = {
  exec: (sql: string) => void;
  prepare: (sql: string) => SqliteStatement;
  close: () => void;
};

/** 当前跑在哪个 runtime 上（写进 `ding doctor` 与错误信息里，排查时有用）。 */
export function sqliteRuntimeName(): "bun" | "node" {
  return typeof (process.versions as { bun?: string }).bun === "string" ? "bun" : "node";
}

/**
 * 打开一个 SQLite 库（同步）。
 *
 * @param file 文件路径（`:memory:` 也可以）
 * @returns 统一的数据库句柄
 * @throws 两家都没有时抛一句能看懂的话（而不是 `Cannot find module`）
 */
export function openSqlite(file: string): SqliteDatabase {
  const runtime = sqliteRuntimeName();
  if (runtime === "bun") {
    const mod = req("bun:sqlite") as { Database: new (f: string) => SqliteDatabase };
    return new mod.Database(file);
  }
  const mod = req("node:sqlite") as { DatabaseSync: new (f: string) => SqliteDatabase };
  return new mod.DatabaseSync(file);
}
