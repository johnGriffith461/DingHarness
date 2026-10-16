import { promises as fsp } from "node:fs";
import path from "node:path";
import { SCHEMA_VERSION, retryAsync, unwrap, wrap, type Migration } from "../../shared/persist";
import { backendKind, kvEntryExisting, kvReadStrict, kvWrite } from "../../engine/adapters/kvStore";

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
 * 4. **读不动就不写**：磁盘版本比本代码新、或迁移链断了 → 返回 `foreign:true`，
 *    调用方**不许回写**，免得把更新的数据降级销毁。
 * 5. **读回一律过 `normalize`**：磁盘上的东西不可信（§49 那次"加完能用、重启就没了"就是漏了这层）。
 * 6. **"真没有"与"读坏了"分开**（P15）：文件不存在 → 兜底值；文件在但 JSON 读不动 →
 *    **先把坏文件另存为 `<file>.corrupt-<时间戳>`**，再给兜底值。绝不把坏文件当空库、
 *    更不许把空库写回去盖掉它 —— 这正是"会静默改坏你资料"那族的根因。
 * 7. **KV 写失败回落文件后，这次写对后续读是可见的**（P95）：回落成功时留一个
 *    `<file>.kv-behind` 记号；读路径先看记号 → 以文件为准并把它搬回 KV，搬成后清掉记号。
 *    没有这一步，KV 里那条旧值会把刚落文件的新值永久盖住，重启即回滚。
 * 8. **KV 里那条值坏了时不回落旧文件**（P132）：坏值只报错并保留原样（`foreign:true`），
 *    不拿迁移日的陈旧 JSON 当权威写回去 —— 那等于用旧数据替换当前数据。
 * 9. **回退开关不装时间机器**（P133）：`DSH_STORE_BACKEND=file` 下若文件停在搬迁那天，
 *    拿 KV 的 `updated_at` 与文件 mtime 比，谁新读谁，并把"文件落后"如实报出来。
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
  /** 磁盘版本比本代码新（或迁移链断了、或数据损坏）：**不许回写**。 */
  foreign: boolean;
  /** 出问题时给人看的一句话（多条说明用「；」并起来，P146）。 */
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

/** 时间戳（文件名安全）：`2026-10-16T08-30-12-345Z`。 */
function stamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function why(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 文件读不动时的三种结果（P15：`missing` 与 `corrupt` **必须**分开）。 */
type FileRead =
  | { status: "missing" }
  | { status: "ok"; raw: unknown }
  | { status: "corrupt"; error: string };

/**
 * 建一个 JSON 落盘器。
 *
 * @param opts 见 `JsonStoreOptions`
 * @returns `{ file, read, write }`
 */
export function createJsonStore<T>(opts: JsonStoreOptions<T>): JsonStore<T> {
  const version = opts.version ?? SCHEMA_VERSION;

  /** 数据目录（KV 库放这儿）：调用方给的是文件路径，取它的目录。 */
  function dir(): string {
    return path.dirname(path.resolve(opts.file()));
  }

  /** 读文件。文件在但 JSON 读不动 → `corrupt`（**不是**空库）。 */
  async function readFileRaw(): Promise<FileRead> {
    try {
      const text = await fsp.readFile(opts.file(), "utf8");
      try {
        return { status: "ok", raw: JSON.parse(text) as unknown };
      } catch (error) {
        return { status: "corrupt", error: why(error) };
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return { status: "missing" };
      // 读不动（权限 / 被占用）也只是"读坏了"，**不是**空库
      return { status: "corrupt", error: why(error) };
    }
  }

  /**
   * 把读不动的文件另存到旁边（`<file>.corrupt-<时间戳>`），返回新位置。
   *
   * 为什么是"挪开"而不是"干脆拒写"：挪开**不丢一个字节**（用户还能人工救），
   * 同时让应用不至于永久卡在只能读的状态。挪不动时返回原路径（由调用方报错）。
   */
  async function quarantine(file: string): Promise<string> {
    const target = `${file}.corrupt-${stamp()}`;
    try {
      await fsp.rename(file, target);
      return target;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return file; // 已被别人挪走 / 删掉
      return file;
    }
  }

  /** 文件改动时刻（毫秒）；没有 → `null`。回退开关比"谁新"用它（P133）。 */
  async function fileMtime(file: string): Promise<number | null> {
    try {
      return (await fsp.stat(file)).mtimeMs;
    } catch {
      return null;
    }
  }

  const behindMarker = (file: string): string => `${file}.kv-behind`;

  async function behindExists(file: string): Promise<boolean> {
    try {
      await fsp.stat(behindMarker(file));
      return true;
    } catch {
      return false;
    }
  }

  async function markBehind(file: string, reason: string): Promise<void> {
    try {
      await fsp.writeFile(behindMarker(file), `${new Date().toISOString()} ${reason}\n`, "utf8");
    } catch {
      /* 记号写不下去也不影响这次落盘：文件里的新值至少是对的 */
    }
  }

  async function clearBehind(file: string): Promise<void> {
    await fsp.rm(behindMarker(file), { force: true }).catch(() => undefined);
  }

  /** 坏文件的统一处置：挪开 + 给兜底值（`foreign:false` —— 坏文件已挪开，写进新文件是安全的）。 */
  async function corruptFileResult(error: string, extra: string[]): Promise<ReadResult<T>> {
    const moved = await quarantine(opts.file());
    const notes = [
      `磁盘上的 JSON 读不动（${error}）`,
      moved === opts.file() ? "原文件仍保留在原处" : `原文件已另存为 ${moved}`,
      "本次用兜底值（**没有**把空库写回去盖掉它）",
      ...extra,
    ];
    return { data: opts.normalize(opts.initial()), from: 0, migrated: false, foreign: false, note: notes.join("；") };
  }

  async function read(): Promise<ReadResult<T>> {
    const notes: string[] = [];
    let raw: unknown;
    let migratedFromFile = false;

    if (backendKind() === "sqlite") {
      /*
       * P95：上次往 KV 写失败、只落到了文件里 → 这次以文件为准，并把它搬回 KV。
       */
      if (await behindExists(opts.file())) {
        const file = await readFileRaw();
        if (file.status === "ok") {
          raw = file.raw;
          migratedFromFile = true;
          notes.push("上次写 SQLite 失败，已按 JSON 文件里那份较新的数据读取并尝试搬回 SQLite");
        } else if (file.status === "corrupt") {
          return corruptFileResult(file.error, ["上次写 SQLite 也失败过"]);
        } else {
          await clearBehind(opts.file()); // 记号在但文件没了 → 记号作废
        }
      }

      if (raw === undefined) {
        let fromKv: ReturnType<typeof kvReadStrict>;
        try {
          fromKv = kvReadStrict(dir(), opts.file());
        } catch (error) {
          // P131：DB 锁住 / 库损坏不该让 14 个 store 集体读不出来 —— 只降级这一条，回落文件
          notes.push(`SQLite 读失败（${why(error)}），本次回落 JSON 文件`);
          fromKv = { status: "missing" };
        }

        if (fromKv.status === "corrupt") {
          /*
           * P132：KV 里这条坏了。**不回落旧文件、不回写** —— 那会把迁移日的陈旧值
           * 当权威覆盖上去（等于静默用旧数据替换当前数据）。坏值保留原样，等人工处理。
           */
          return {
            data: opts.normalize(opts.initial()),
            from: 0,
            migrated: false,
            foreign: true,
            note: `SQLite 里这份数据的值损坏（最后写入 ${new Date(fromKv.updatedAt).toISOString()}）—— 已保留原样，未回落旧文件、也未覆盖；请人工处理`,
          };
        }

        if (fromKv.status === "ok") {
          raw = fromKv.value;
        } else {
          // KV 里还没有这条 → 去读老的 JSON 文件（**只读旧**），读到就地搬进 KV，老文件原样留着
          const file = await readFileRaw();
          if (file.status === "corrupt") return corruptFileResult(file.error, notes);
          if (file.status === "missing") {
            const fresh: ReadResult<T> = { data: opts.initial(), from: version, migrated: false, foreign: false };
            return notes.length ? { ...fresh, note: notes.join("；") } : fresh;
          }
          raw = file.raw;
          migratedFromFile = true;
        }
      }
    } else {
      /*
       * 回退开关（P133）：`file` 只该切介质，不该变成时间机器。
       * 老文件可能停在"搬迁那天"，所以拿 KV 的 updated_at 与文件 mtime 比，谁新用谁，
       * 并把"文件落后"如实报出来 —— 否则用户看到的是"设置全被回滚"。
       */
      const kv = kvEntryExisting(dir(), opts.file());
      const mtime = await fileMtime(opts.file());
      const kvNewer = kv !== null && (mtime === null || kv.updatedAt > mtime + 1000);
      const file = await readFileRaw();
      if (file.status === "corrupt") return corruptFileResult(file.error, ["（回退开关生效期间）"]);
      if (kv && (file.status === "missing" || kvNewer)) {
        raw = kv.value;
        notes.push(
          file.status === "missing"
            ? "回退开关生效，但 JSON 文件不存在 —— 已按 SQLite 里的最新值读取"
            : `回退开关生效，但 JSON 文件落后于 SQLite（最后写入 ${new Date(kv.updatedAt).toISOString()}）—— 已按 SQLite 的最新值读取`,
        );
      } else if (file.status === "missing") {
        const fresh: ReadResult<T> = { data: opts.initial(), from: version, migrated: false, foreign: false };
        return notes.length ? { ...fresh, note: notes.join("；") } : fresh;
      } else {
        raw = file.raw;
      }
    }

    const got = unwrap<unknown>(raw, { version, migrations: opts.migrations, initial: opts.initial });
    if (!got.ok) {
      return {
        data: opts.normalize(got.data),
        from: 0,
        migrated: false,
        foreign: true,
        note: [got.reason, ...notes].join("；"),
      };
    }
    const data = opts.normalize(got.data);
    if (migratedFromFile && backendKind() === "sqlite") {
      // 搬迁：把**当前版**（可能刚从老版本升上来）写进 KV；老文件不动
      try {
        kvWrite(dir(), opts.file(), wrap(data, version));
        await clearBehind(opts.file()); // 搬回成功 → KV 不再落后
      } catch {
        /* 写不进 KV 不影响这次读取 —— 下次再搬 */
      }
    }
    if (got.migrated) notes.unshift(`已从第 ${got.from} 版数据升级到第 ${version} 版`);
    if (migratedFromFile && backendKind() === "sqlite") notes.push(`${opts.file()} 的老数据已搬进 SQLite（原文件保留）`);
    return {
      data,
      from: got.from,
      migrated: got.migrated,
      foreign: false,
      ...(notes.length ? { note: notes.join("；") } : {}),
    };
  }

  async function write(value: T): Promise<WriteResult> {
    const wrapped = wrap(opts.normalize(value), version);
    if (backendKind() === "sqlite") {
      try {
        kvWrite(dir(), opts.file(), wrapped);
        await clearBehind(opts.file());
        return { ok: true };
      } catch (error) {
        /*
         * ⚠️ KV 写失败**回落到文件**，而不是直接报失败：
         * 配置型数据（设置、记忆、任务）丢了，比"这份数据暂时不在 SQLite 里"严重得多。
         *
         * P95：回落成功还不够 —— KV 里那条**旧值**会盖住刚落文件的新值（读只看 KV）。
         * 所以留一个 `.kv-behind` 记号，读路径据此以文件为准并把它搬回 KV。
         */
        const fell = await writeFile(wrapped, why(error));
        if (fell.ok) await markBehind(opts.file(), why(error));
        return fell;
      }
    }
    return writeFile(wrapped);
  }

  /** 文件后端：回退开关（`DSH_STORE_BACKEND=file`）走它，KV 写失败也走它。 */
  async function writeFile(wrapped: unknown, kvError?: string): Promise<WriteResult> {
    const target = opts.file();
    const body = `${JSON.stringify(wrapped, null, 2)}\n`;
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
      const err = why(error);
      return { ok: false, error: kvError ? `${err}（KV 也写过一次：${kvError}）` : err };
    }
  }

  return { file: opts.file, read, write };
}
