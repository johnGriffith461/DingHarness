import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SCHEMA_VERSION, wrap } from "@shared/persist";
import { createJsonStore } from "../electron/ipc/jsonStore";
import * as kv from "../engine/adapters/kvStore";
import { KV_FILE, backendKind, closeKv, kvKeyFor, kvList, kvRead, kvReadStrict, kvStoreKey, kvWrite, normalizeKvDir } from "../engine/adapters/kvStore";
import { openSqlite } from "../engine/adapters/sqliteDriver";
import { removeAll } from "./testFs";

/**
 * 存储 SQLite 化（Phase 12.1）—— **KV 后端 + 迁移 + 回退开关 + 数据安全的边界**。
 *
 * ## 为什么单开一套，而不是改 `ipcStores.test.ts`
 *
 * 那一套断言的是**文件后端**的规格（磁盘上那个 JSON 长什么样），而文件后端现在是
 * **回退开关**那条路 —— 依然要有人盯着。两套各测一条路，合起来才覆盖
 * "默认走 SQLite" + "想退回去能退回去"。
 *
 * ## 2026-10-16 补的那几条（都是"会静默改坏你资料"那一族）
 *
 * | 条 | 症状 | 用例 |
 * |---|---|---|
 * | P100/P128 | 键是本机绝对路径 → 跨机器恢复静默落空 | ⑦ |
 * | （兼容） | 老库里的绝对路径键不能读不出来 | ⑧ |
 * | P95 | KV 写失败回落文件后，那次写对后续读**永久不可见** | ⑨ |
 * | P131 | KV 读抛异常 → 14 个 store 集体读不出来 | ⑩ |
 * | P132 | 一条坏值 → 陈旧 JSON 被当权威写回 | ⑥ |
 * | P133 | 回退开关读到"冻结在迁移日"的旧文件 | ⑪ |
 * | P142 | `handles` 的键没归一 → 关不掉句柄 | ⑫ |
 * | P15 | 读坏的文件被当"空库"，随后的写盖掉它 | ⑬ |
 */

const env = { userData: "" };

vi.mock("electron", () => ({
  app: {
    getPath: (what: string) => {
      if (what === "userData") return env.userData;
      throw new Error(`测试里没有 mock 的路径：${what}`);
    },
  },
}));

/** 一个最小的 store（形状与真实那 14 个一致：file + initial + normalize）。 */
function makeStore(dir = env.userData) {
  return createJsonStore<{ items: string[] }>({
    file: () => path.join(dir, "demo.json"),
    initial: () => ({ items: [] }),
    normalize: (v) => ({ items: Array.isArray((v as { items?: unknown })?.items) ? (v as { items: string[] }).items : [] }),
  });
}

/** 直接往 KV 里写一行原始文本（模拟"磁盘被改坏"）。 */
function writeRaw(dir: string, key: string, value: string): void {
  const db = openSqlite(path.join(dir, KV_FILE));
  try {
    db.exec(
      "CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)",
    );
    db.prepare("INSERT OR REPLACE INTO kv (key, value, updated_at) VALUES (?, ?, ?)").run(key, value, Date.now());
  } finally {
    db.close();
  }
}

/** 库里的键（原样读，不做归一）。 */
function rawKeys(dir: string): string[] {
  const db = openSqlite(path.join(dir, KV_FILE));
  try {
    return (db.prepare("SELECT key FROM kv ORDER BY key").all() as Array<{ key: string }>).map((r) => r.key);
  } finally {
    db.close();
  }
}

beforeEach(() => {
  env.userData = fs.mkdtempSync(path.join(os.tmpdir(), "dh-kv-"));
  delete process.env.DSH_STORE_BACKEND; // 默认 = SQLite
});

afterEach(() => {
  vi.restoreAllMocks();
  closeKv(env.userData);
  removeAll(env.userData);
  delete process.env.DSH_STORE_BACKEND;
});

describe("配置型 store 的 SQLite KV 后端（Phase 12.1）", () => {
  it("① 默认走 SQLite：写进 KV、信封带版本、读回来是同一份东西", async () => {
    expect(backendKind(), "默认后端应当是 sqlite").toBe("sqlite");
    const store = makeStore();
    const wrote = await store.write({ items: ["甲", "乙"] });
    expect(wrote.ok).toBe(true);

    // 信封与版本**必须**还在（换介质不该把版本机制弄丢）
    const raw = kvRead(env.userData, store.file()) as { __schema: number; data: { items: string[] } };
    expect(raw.__schema).toBe(SCHEMA_VERSION);
    expect(raw.data.items).toEqual(["甲", "乙"]);

    // 读回来一致（并且过 normalize）
    const got = await store.read();
    expect(got.data.items).toEqual(["甲", "乙"]);
    expect(got.foreign).toBe(false);

    // 默认模式下**不该**再写那个 JSON 文件（这才是"换介质"的意思）
    expect(fs.existsSync(store.file()), "SQLite 模式下还在写 JSON 文件").toBe(false);
    // 库文件出现了
    expect(fs.existsSync(path.join(env.userData, KV_FILE))).toBe(true);
  });

  it("② 迁移只读旧、写新、不删旧：老 JSON 会被搬进 KV，而老文件原样留着", async () => {
    // 先摆一份"上一版留下的"文件（信封 + 第 1 版）
    const store = makeStore();
    const file = store.file();
    fs.mkdirSync(env.userData, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(wrap({ items: ["老数据"] }, 1), null, 2), "utf8");
    const before = fs.readFileSync(file, "utf8");

    // 第一次读：应当从文件搬进 KV，并给出说明
    const first = await store.read();
    expect(first.data.items).toEqual(["老数据"]);
    expect(first.note ?? "", "搬迁时应当说明一句").toContain("已搬进 SQLite");
    // 老文件**一字未动**
    expect(fs.readFileSync(file, "utf8")).toBe(before);
    // 而 KV 里已经有了它
    expect(kvRead(env.userData, file)).toBeTruthy();

    // 第二次读走 KV（把老文件删掉也不影响 —— 证明真的搬过去了）
    fs.rmSync(file);
    const second = await store.read();
    expect(second.data.items).toEqual(["老数据"]);
  });

  it("③ 回退开关：DSH_STORE_BACKEND=file 让它回到 JSON 文件，数据照常", async () => {
    process.env.DSH_STORE_BACKEND = "file";
    expect(backendKind()).toBe("file");
    const store = makeStore();
    await store.write({ items: ["文件后端"] });
    expect(fs.existsSync(store.file()), "回退模式下应当写 JSON 文件").toBe(true);
    expect((await store.read()).data.items).toEqual(["文件后端"]);
    // 回退模式下不碰 KV
    expect(kvRead(env.userData, store.file())).toBeNull();
  });

  it("④ 磁盘上的值版本比本代码新时：判 foreign（**不许回写**），与文件后端同一口径", async () => {
    const store = makeStore();
    fs.mkdirSync(env.userData, { recursive: true });
    // 直接往 KV 里塞一个更高的版本
    kvWrite(env.userData, store.file(), wrap({ items: ["未来数据"] }, SCHEMA_VERSION + 5));
    const got = await store.read();
    expect(got.foreign, "更高版本没有被判成 foreign —— 那会把它降级销毁").toBe(true);
    expect(got.note ?? "").toBeTruthy();
  });

  it("⑤ 键是文件的路径：不同目录下的同名文件不会撞在一起", async () => {
    const other = fs.mkdtempSync(path.join(os.tmpdir(), "dh-kv2-"));
    try {
      const a = makeStore(env.userData);
      const b = makeStore(other);
      await a.write({ items: ["A"] });
      await b.write({ items: ["B"] });
      expect((await a.read()).data.items).toEqual(["A"]);
      expect((await b.read()).data.items).toEqual(["B"]);
      // 两个键都在（一键一份数据）；键本身是**相对数据目录**的 "demo.json"（P100/P128）
      expect(kvList(env.userData).map((e) => e.key)).toEqual(["demo.json"]);
      expect(kvList(other).map((e) => e.key)).toEqual(["demo.json"]);
    } finally {
      closeKv(other);
      fs.rmSync(other, { recursive: true, force: true });
    }
  });

  it("⑥ ⭐ G88/P132：一条坏值真的走到「按坏值处理」那条分支（而不是靠键没对上蒙过去）", async () => {
    const store = makeStore();
    fs.mkdirSync(env.userData, { recursive: true });
    /*
     * ⚠️ 键用**实现自己的**归一化函数拼。
     * G88 的原形是硬编码 `path.resolve(store.file()).toLowerCase()` —— 而实现只在
     * `process.platform === "win32"` 时 lower-case，于是 Linux/macOS 上（`mkdtempSync`
     * 的随机后缀含大写）插入的键与读取的键**不是同一个**，用例"因为压根没读到那条"
     * 而恒绿；断言 `items === []` 与"没读到 → 兜底值"又是同一个结果。
     */
    writeRaw(env.userData, kvStoreKey(env.userData, store.file()), "{ 这不是合法 json");
    closeKv(env.userData); // 让句柄重开，读到刚写的那条

    // 先证明那条坏值**真的在库里、也真的被读到了**（这一步红了就是 G88 复发）
    expect(kvReadStrict(env.userData, store.file()).status).toBe("corrupt");

    const got = await store.read();
    expect(got.data.items).toEqual([]); // 兜底值，而不是抛异常
    // P132：坏值**不许**被当成"没有"，更不许回落陈旧文件再写回去
    expect(got.foreign, "坏值被当成「没有」了 —— 那会拿陈旧 JSON 覆盖当前数据").toBe(true);
    expect(got.note ?? "").toContain("损坏");
    expect(rawKeys(env.userData), "坏值那条被覆盖掉了（本该原样留着）").toContain(kvStoreKey(env.userData, store.file()));
  });

  it("⑦ ⭐ P100/P128：键与数据目录无关 —— 把库搬到另一个目录也读得回来", async () => {
    const a = makeStore(env.userData);
    await a.write({ items: ["甲"] });
    // 模拟"另一台机器/另一个数据目录"：把整份库文件拷过去，数据文件路径完全不同
    closeKv(env.userData);
    const other = fs.mkdtempSync(path.join(os.tmpdir(), "dh-kv-other-"));
    try {
      fs.copyFileSync(path.join(env.userData, KV_FILE), path.join(other, KV_FILE));
      const b = makeStore(other);
      const got = await b.read();
      /*
       * 旧键是绝对路径（`c:\users\alice\...\demo.json`）→ 这里必然读成空。
       * 现在的键是相对键（`demo.json`）→ 换个目录照样命中。
       */
      expect(got.data.items, "跨目录/跨机器恢复成了静默空操作（P100/P128 复发）").toEqual(["甲"]);
      expect(got.note ?? "", "这份数据是从 KV 直接读到的，不该走「老文件搬迁」那条说明").not.toContain("已搬进 SQLite");
    } finally {
      closeKv(other);
      fs.rmSync(other, { recursive: true, force: true });
    }
  });

  it("⑧ 老键（绝对路径）仍读得到，并就地搬成稳定键", async () => {
    const store = makeStore();
    fs.mkdirSync(env.userData, { recursive: true });
    // 改动之前写进库里的键长这样（绝对路径，win32 下小写）
    writeRaw(env.userData, kvKeyFor(store.file()), JSON.stringify(wrap({ items: ["老键值"] }, SCHEMA_VERSION)));
    closeKv(env.userData);

    const got = await store.read();
    expect(got.data.items, "老键读不出来了 —— 升级后用户的数据就『丢了』").toEqual(["老键值"]);
    // 已就地搬成稳定键（旧键删掉，避免同一个 store 在备份里出现两条）
    expect(rawKeys(env.userData)).toEqual([kvStoreKey(env.userData, store.file())]);
  });

  it("⑨ ⭐ P95：KV 写失败回落文件后，那次写对后续读**必须可见**", async () => {
    const store = makeStore();
    await store.write({ items: ["旧"] }); // KV 里先有一份旧值

    // 制造一次"KV 写失败"（SQLITE_BUSY / 杀软锁库都是这个形状）
    const spy = vi.spyOn(kv, "kvWrite").mockImplementation(() => {
      throw new Error("模拟 SQLITE_BUSY");
    });
    const res = await store.write({ items: ["新"] });
    spy.mockRestore();
    expect(res.ok, "KV 写失败时应当回落到文件并算成功（数据没丢）").toBe(true);
    // 值确实落到了文件里
    expect(JSON.stringify(JSON.parse(fs.readFileSync(store.file(), "utf8")))).toContain("新");

    closeKv(env.userData); // 重开句柄：模拟"重启之后"
    const got = await store.read();
    expect(got.data.items, "回落到文件里的那次写对后续读不可见（重启即回滚）").toEqual(["新"]);
  });

  it("⑩ ⭐ P131：SQLite 读抛异常只降级那一条，回落文件，不让 14 个 store 集体读不出来", async () => {
    const store = makeStore();
    fs.mkdirSync(env.userData, { recursive: true });
    // 库文件的位置被一个**目录**占了 → 开库必失败（db 被锁坏/损坏是同一个形状）
    fs.mkdirSync(path.join(env.userData, KV_FILE));
    // 而文件里有能救的数据
    fs.writeFileSync(store.file(), JSON.stringify(wrap({ items: ["文件里的"] }, SCHEMA_VERSION)), "utf8");

    const got = await store.read();
    expect(got.data.items, "SQLite 读失败把整条读路弄崩了（P131 复发）").toEqual(["文件里的"]);
    expect(got.note ?? "").toContain("SQLite 读失败");
  });

  it("⑩b P131：数据目录还不存在时也不该抛（句柄层要先建目录）", async () => {
    const nested = path.join(env.userData, "还没建的子目录");
    try {
      const store = makeStore(nested);
      const got = await store.read();
      expect(got.data.items).toEqual([]);
      expect(got.foreign).toBe(false);
    } finally {
      // 这个子目录另有一个句柄，收尾时也要关掉（Windows 上句柄没放掉目录删不掉）
      closeKv(nested);
    }
  });

  it("⑪ ⭐ P133：回退开关不该变成时间机器（文件停在搬迁日 → 读 KV 的最新值并报出来）", async () => {
    const store = makeStore();
    await store.write({ items: ["KV 最新"] }); // 写进 KV
    fs.mkdirSync(env.userData, { recursive: true });
    // 老文件停在"搬迁那天"的旧值，且 mtime 明显更早
    fs.writeFileSync(store.file(), JSON.stringify(wrap({ items: ["迁移日旧值"] }, SCHEMA_VERSION)), "utf8");
    const old = (Date.now() - 60_000) / 1000;
    fs.utimesSync(store.file(), old, old);

    process.env.DSH_STORE_BACKEND = "file";
    const got = await store.read();
    expect(got.data.items, "回退开关读到的是冻结在迁移日的陈旧文件（设置被静默回滚）").toEqual(["KV 最新"]);
    expect(got.note ?? "", "『文件落后于 KV』这件事必须说出来").toContain("落后于 SQLite");

    // 反过来：文件确实更新时，仍以文件为准（别把开关搞成"永远读 KV"）
    fs.writeFileSync(store.file(), JSON.stringify(wrap({ items: ["文件更新"] }, SCHEMA_VERSION)), "utf8");
    const future = (Date.now() + 60_000) / 1000;
    fs.utimesSync(store.file(), future, future);
    const got2 = await store.read();
    expect(got2.data.items).toEqual(["文件更新"]);
  });

  it("⑫ P142：句柄缓存的键与键归一化同一口径（大小写不同的同一个目录只算一个句柄）", () => {
    kvWrite(env.userData, path.join(env.userData, "demo.json"), { a: 1 }); // 建句柄
    const upper = process.platform === "win32" ? path.resolve(env.userData).toUpperCase() : env.userData;
    // 归一化口径一致 → 换一种大小写写法必须命中同一个缓存键
    expect(normalizeKvDir(upper)).toBe(normalizeKvDir(env.userData));
    closeKv(upper);
    /*
     * 句柄真关掉了 → Windows 上库文件能删（被 sqlite 句柄占着时删除返回 EBUSY/EPERM）。
     * 非 Windows 上删一个被打开的文件本来就成功，这条在那里不做判别（不制造假红）。
     */
    expect(() => fs.rmSync(path.join(env.userData, KV_FILE), { force: true })).not.toThrow();
  });

  it("⑬ ⭐ P15：读坏的文件不当「空库」，也不许把兜底值写回去盖掉它", async () => {
    process.env.DSH_STORE_BACKEND = "file"; // 文件后端是这条路径最直白的入口
    const store = makeStore();
    fs.mkdirSync(env.userData, { recursive: true });
    const bad = "{ 这不是合法 json（用户手改坏了）";
    fs.writeFileSync(store.file(), bad, "utf8");

    const got = await store.read();
    expect(got.data.items).toEqual([]); // 兜底值，界面起得来
    expect(got.note ?? "", "读坏了却什么都没说").toContain("读不动");
    // 原文件**没有**被当空库覆盖：它被另存到 .corrupt-* 下，一个字节都没变
    const quarantined = fs.readdirSync(env.userData).filter((f) => f.startsWith("demo.json.corrupt-"));
    expect(quarantined.length, "坏文件应当被另存一份（而不是丢掉）").toBe(1);
    expect(fs.readFileSync(path.join(env.userData, quarantined[0]), "utf8")).toBe(bad);
  });

  it("⑭ P146：跨版本搬迁时**两条说明并列**（后一条不许把前一条盖掉）", async () => {
    const store = createJsonStore<{ items: string[] }>({
      file: () => path.join(env.userData, "demo.json"),
      initial: () => ({ items: [] }),
      normalize: (v) => ({ items: Array.isArray((v as { items?: unknown })?.items) ? (v as { items: string[] }).items : [] }),
      version: 2,
      migrations: { 0: (d) => d, 1: (d) => d },
    });
    fs.mkdirSync(env.userData, { recursive: true });
    // 裸数据（版本 0）落在文件里 → 一次读会同时发生"跨版本迁移"与"搬进 SQLite"两件事
    fs.writeFileSync(store.file(), JSON.stringify({ items: ["裸数据"] }), "utf8");
    const got = await store.read();
    expect(got.migrated).toBe(true);
    // 两条说明都要在（旧的 `...note` 两次展开，后者恒覆盖前者 → 第一条永远看不到）
    expect(got.note ?? "", "「升到第几版」那句被「搬进 SQLite」盖掉了").toContain("已从第 0 版数据升级到第 2 版");
    expect(got.note ?? "").toContain("已搬进 SQLite");
  });
});

describe("kvStore 的写法守卫（P143）", () => {
  it("没有留下没人读的死状态（`Handle.keyed` 那种半成品）", () => {
    const src = fs.readFileSync(path.join(__dirname, "..", "engine", "adapters", "kvStore.ts"), "utf8");
    expect(src, "Handle 上又挂了一个没人读的缓存层 —— 读代码的人会以为有内存缓存").not.toContain("keyed");
  });
});
