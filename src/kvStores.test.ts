import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SCHEMA_VERSION, wrap } from "@shared/persist";
import { createJsonStore } from "../electron/ipc/jsonStore";
import { KV_FILE, backendKind, closeKv, kvList, kvRead, kvWrite } from "../engine/adapters/kvStore";
import { removeAll } from "./testFs";

/**
 * 存储 SQLite 化（Phase 12.1）—— **KV 后端 + 迁移 + 回退开关**。
 *
 * ## 为什么单开一套，而不是改 `ipcStores.test.ts`
 *
 * 那一套断言的是**文件后端**的规格（磁盘上那个 JSON 长什么样），而文件后端现在是
 * **回退开关**那条路 —— 依然要有人盯着。两套各测一条路，合起来才覆盖
 * "默认走 SQLite" + "想退回去能退回去"。
 *
 * ## 方案 12.1 的三条原文要求，逐条对应到下面
 *
 * | 要求 | 用例 |
 * |---|---|
 * | 配置型 store → SQLite KV + **信封版本** | ① |
 * | 迁移**只读旧、写新、不删旧** | ② |
 * | **回退开关** | ③ |
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
function makeStore() {
  return createJsonStore<{ items: string[] }>({
    file: () => path.join(env.userData, "demo.json"),
    initial: () => ({ items: [] }),
    normalize: (v) => ({ items: Array.isArray((v as { items?: unknown })?.items) ? ((v as { items: string[] }).items) : [] }),
  });
}

beforeEach(() => {
  env.userData = fs.mkdtempSync(path.join(os.tmpdir(), "dh-kv-"));
  delete process.env.DSH_STORE_BACKEND; // 默认 = SQLite
});

afterEach(() => {
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

  it("⑤ 键是文件的绝对路径：不同目录下的同名文件不会撞在一起", async () => {
    const other = fs.mkdtempSync(path.join(os.tmpdir(), "dh-kv2-"));
    try {
      const a = createJsonStore<{ items: string[] }>({
        file: () => path.join(env.userData, "same.json"),
        initial: () => ({ items: [] }),
        normalize: (v) => v as { items: string[] },
      });
      const b = createJsonStore<{ items: string[] }>({
        file: () => path.join(other, "same.json"),
        initial: () => ({ items: [] }),
        normalize: (v) => v as { items: string[] },
      });
      await a.write({ items: ["A"] });
      await b.write({ items: ["B"] });
      expect((await a.read()).data.items).toEqual(["A"]);
      expect((await b.read()).data.items).toEqual(["B"]);
      // 两个键都在（一键一份数据）
      expect(kvList(env.userData).length).toBe(1);
      expect(kvList(other).length).toBe(1);
    } finally {
      closeKv(other);
      fs.rmSync(other, { recursive: true, force: true });
    }
  });

  it("⑥ 一条坏值不该把读弄崩：按「没有」处理，回落到兜底值", async () => {
    const store = makeStore();
    fs.mkdirSync(env.userData, { recursive: true });
    // 手写一条坏 JSON 进 KV（模拟磁盘被改坏）
    const { openSqlite } = await import("../engine/adapters/sqliteDriver");
    const db = openSqlite(path.join(env.userData, KV_FILE));
    db.exec("CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)");
    db.prepare("INSERT OR REPLACE INTO kv (key, value, updated_at) VALUES (?, ?, ?)").run(
      path.resolve(store.file()).toLowerCase(),
      "{ 这不是合法 json",
      Date.now(),
    );
    db.close();
    closeKv(env.userData); // 让句柄重开，读到刚写的那条

    const got = await store.read();
    expect(got.data.items).toEqual([]); // 兜底值，而不是抛异常
  });
});
