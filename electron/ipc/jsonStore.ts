import { promises as fsp } from "node:fs";
import path from "node:path";
import { SCHEMA_VERSION, retryAsync, unwrap, wrap, type Migration } from "../../shared/persist";

/**
 * 主进程侧的 JSON 落盘（C1）。
 *
 * ## 为什么有它
 *
 * 原来 12 个模块各写一份"读 json / 写 json"，保证强度不一：
 * `memoryStore` **连原子写都没有**、**没有任何一个**有写失败重试、
 * 只有画布有 `version`（而它没有任何迁移分支）。这里把那条保证收成**一份**：
 *
 * 1. **原子写**：先写 `<file>.<pid>.<n>.tmp` 再 `rename` —— 断电/崩溃不会留下半截 JSON。
 * 2. **写失败重试 3 次**（带退避）：Windows 上的失败大多是一次性冲突（杀软/索引器/句柄）。
 * 3. **信封 + 版本 + 前向迁移**：判断在 `shared/persist.ts`（**纯逻辑，有单测**），这里只负责落盘。
 * 4. **读不动就不写**：磁盘版本比本代码新、或迁移链断了 → 返回 `ok:false`，
 *    调用方**不许回写**，免得把更新的数据降级销毁。
 * 5. **读回一律过 `normalize`**：磁盘上的东西不可信（§49 那次"加完能用、重启就没了"就是漏了这层）。
 *
 * ## 用法
 *
 * ```ts
 * const store = createJsonStore<Task[]>({
 *   file: () => tasksPath(),
 *   initial: () => [],
 *   normalize: (v) => (Array.isArray(v) ? v : []),
 * });
 * await store.write(next);
 * ```
 */

/** 一次读的结果。 */
export type ReadResult<T> = {
  data: T;
  /** 磁盘上是第几版（裸数据算 0）。 */
  from: number;
  /** 跑过迁移 → 建议回写一次让磁盘也升上来。 */
  migrated: boolean;
  /** 磁盘版本比本代码新（或迁移链断了）：**不许回写**。 */
  foreign: boolean;
  /** 出问题时给人看的一句话。 */
  note?: string;
};

/** 一次写的结果。 */
export type WriteResult = { ok: true } | { ok: false; error: string };

export type JsonStore<T> = {
  /** 数据文件的绝对路径（每次调用都问一次：`app.getPath` 在打包前后不同）。 */
  file: () => string;
  read: () => Promise<ReadResult<T>>;
  write: (value: T) => Promise<WriteResult>;
};

export type JsonStoreOptions<T> = {
  /** 绝对路径；用函数是因为 `app.getPath("userData")` 可能晚于模块加载才可用。 */
  file: () => string;
  /** 文件不存在 / 坏了时的兜底值。 */
  initial: () => T;
  /**
   * 归一化：**所有**从磁盘读出来的值都要过它。
   *
   * 这是"磁盘不可信"那一条的落点 —— 少了它，一个手改过的文件就能让界面崩。
   */
  normalize: (value: unknown) => T;
  /** 本代码期望的版本（默认取 `shared/persist` 的当前版）。 */
  version?: number;
  /** 迁移表：`migrations[0]` 是"裸数据 → 版本 1"。 */
  migrations?: Record<number, Migration>;
  /** 写失败重试次数（含第一次）。 */
  attempts?: number;
};

/** 生成临时文件名（同目录，保证 `rename` 是同卷原子操作）。 */
let tmpSeq = 0;
function tempNameFor(file: string): string {
  tmpSeq += 1;
  return `${file}.${process.pid}.${tmpSeq}.tmp`;
}

/**
 * 建一个 JSON 落盘器。
 *
 * @param opts 见 `JsonStoreOptions`
 * @returns `{ file, read, write }`
 */
export function createJsonStore<T>(opts: JsonStoreOptions<T>): JsonStore<T> {
  const version = opts.version ?? SCHEMA_VERSION;

  async function read(): Promise<ReadResult<T>> {
    let raw: unknown;
    try {
      const text = await fsp.readFile(opts.file(), "utf8");
      raw = JSON.parse(text) as unknown;
    } catch {
      // 文件不存在 / 读不了 / JSON 坏了：都不算错误 —— 给兜底值，让应用能起来
      return { data: opts.initial(), from: version, migrated: false, foreign: false };
    }

    const got = unwrap<unknown>(raw, { version, migrations: opts.migrations, initial: opts.initial });
    if (!got.ok) {
      return { data: opts.normalize(got.data), from: 0, migrated: false, foreign: true, note: got.reason };
    }
    return {
      data: opts.normalize(got.data),
      from: got.from,
      migrated: got.migrated,
      foreign: false,
      ...(got.migrated ? { note: `已从第 ${got.from} 版数据升级到第 ${version} 版` } : {}),
    };
  }

  async function write(value: T): Promise<WriteResult> {
    const target = opts.file();
    const body = `${JSON.stringify(wrap(opts.normalize(value), version), null, 2)}\n`;
    try {
      await fsp.mkdir(path.dirname(target), { recursive: true });
      await retryAsync(
        async () => {
          const temp = tempNameFor(target);
          try {
            await fsp.writeFile(temp, body, "utf8");
            await fsp.rename(temp, target);
          } catch (error) {
            // 失败要把临时文件收掉，否则 userData 里会堆一地 .tmp
            await fsp.rm(temp, { force: true }).catch(() => undefined);
            throw error;
          }
        },
        { attempts: opts.attempts ?? 3 },
      );
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  return { file: opts.file, read, write };
}
