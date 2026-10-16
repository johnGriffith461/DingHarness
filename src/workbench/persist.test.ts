import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { SCHEMA_VERSION, isEnvelope, retryAsync, unwrap, wrap } from "@shared/persist";
import { createJsonStore } from "../../electron/ipc/jsonStore";

/**
 * C1：持久化的两条保证 —— **信封/迁移** 与 **原子写+重试**。
 *
 * ## 为什么这些断言必须存在
 *
 * 这 12 个模块原来各写一份"读 json / 写 json"，保证强度不一：内存库**连原子写都没有**、
 * **没有一处重试**、只有画布有 `version` 而它**没有迁移分支**。
 * 把保证收成一份之后，**这份收窄必须被钉住**，否则下一次"再抄一份"就又把强度打散了。
 *
 * 最重要的一条是 **旧数据必须能读**：磁盘上现在存的是**裸 JSON**（没有信封），
 * 上线信封的那一天，用户手里的文件全是"版本 0" —— 读不出来的话，那不是升级，是清库。
 */

/* ───────────────────── 纯逻辑：信封与迁移 ───────────────────── */

describe("信封", () => {
  it("包出来的东西能被认出来，业务数据里的 v 不会被认成信封", () => {
    expect(isEnvelope(wrap({ a: 1 }))).toBe(true);
    // ⚠️ 用 `__schema` 而不是 `v`：业务数据自己带 v 时不能被误判成信封（那是静默丢数据）
    expect(isEnvelope({ v: 3, data: { a: 1 } })).toBe(false);
    expect(isEnvelope({ __schema: 1 })).toBe(false); // 有版本没数据，不算
    expect(isEnvelope([])).toBe(false);
    expect(isEnvelope(null)).toBe(false);
  });
});

describe("unwrap · 旧数据必须能读", () => {
  const migrations = {
    // 裸数据（版本 0）→ 版本 1：把一个裸数组包成 {items:[...]}
    0: (old: unknown) => ({ items: Array.isArray(old) ? old : [] }),
  };

  it("⭐ 裸数据（无信封）被当成版本 0，并跑迁移到当前版", () => {
    const got = unwrap(["a", "b"], { version: 1, migrations, initial: () => ({ items: [] }) });
    expect(got.ok).toBe(true);
    if (!got.ok) return;
    expect(got.data).toEqual({ items: ["a", "b"] });
    expect(got.from).toBe(0);
    expect(got.migrated).toBe(true);
  });

  it("⭐⭐ 裸数据 + **没有**迁移表 → 原样读出来（上线信封那天不能变成清库）", () => {
    const got = unwrap({ entries: ["用户的东西"] }, { version: 1, initial: () => ({ entries: [] }) });
    expect(got.ok).toBe(true);
    if (!got.ok) return;
    expect(got.data).toEqual({ entries: ["用户的东西"] });
    expect(got.from).toBe(0);
    expect(got.migrated).toBe(true);
  });

  it("版本已经等于当前 → 原样用，不迁", () => {
    const got = unwrap(wrap({ items: ["x"] }, 1), { version: 1, migrations, initial: () => ({ items: [] }) });
    expect(got.ok).toBe(true);
    if (!got.ok) return;
    expect(got.data).toEqual({ items: ["x"] });
    expect(got.migrated).toBe(false);
  });

  it("多步迁移按顺序跑（0 → 1 → 2）", () => {
    const got = unwrap(["a"], {
      version: 2,
      migrations: { 0: (d) => ({ items: d }), 1: (d) => ({ ...(d as object), tag: "v2" }) },
      initial: () => ({ items: [], tag: "" }),
    });
    expect(got.ok).toBe(true);
    if (!got.ok) return;
    expect(got.data).toEqual({ items: ["a"], tag: "v2" });
  });

  it("空 / null → 兜底值（第一次运行没有文件是正常的）", () => {
    for (const raw of [undefined, null]) {
      const got = unwrap(raw, { version: 1, migrations, initial: () => ({ items: ["fresh"] }) });
      expect(got.ok).toBe(true);
      if (got.ok) expect(got.data).toEqual({ items: ["fresh"] });
    }
  });

  it("⚠️ 磁盘版本比本代码新 → 拒绝，并明确标 foreign（不许回写）", () => {
    const got = unwrap(wrap({ items: ["future"] }, 99), { version: 1, migrations, initial: () => ({ items: [] }) });
    expect(got.ok).toBe(false);
    if (got.ok) return;
    expect(got.foreign).toBe(true);
    expect(got.reason).toContain("99");
  });

  it("迁移链断了 → 也拒绝，而不是读进去一半", () => {
    const got = unwrap(["a"], { version: 3, migrations: { 0: (d) => d }, initial: () => ({ items: [] }) });
    expect(got.ok).toBe(false);
    if (got.ok) return;
    expect(got.foreign).toBe(true);
    expect(got.reason).toContain("迁移");
  });
});

describe("retryAsync", () => {
  /** 不真的等的 sleep，让测试是确定性的、不拖时间。 */
  const noSleep = async (): Promise<void> => undefined;

  it("第 N 次成功就返回，并且不再多试", async () => {
    let calls = 0;
    const got = await retryAsync(
      async () => {
        calls += 1;
        if (calls < 3) throw new Error("占用中");
        return "ok";
      },
      { attempts: 5, sleep: noSleep },
    );
    expect(got).toBe("ok");
    expect(calls).toBe(3);
  });

  it("全失败就把最后一次的错抛出去（不吞）", async () => {
    let calls = 0;
    await expect(
      retryAsync(
        async () => {
          calls += 1;
          throw new Error(`第 ${calls} 次也失败`);
        },
        { attempts: 3, sleep: noSleep },
      ),
    ).rejects.toThrow("第 3 次也失败");
    expect(calls).toBe(3);
  });

  it("`attempts: 1` 就是只试一次", async () => {
    let calls = 0;
    await expect(
      retryAsync(
        async () => {
          calls += 1;
          throw new Error("x");
        },
        { attempts: 1, sleep: noSleep },
      ),
    ).rejects.toThrow();
    expect(calls).toBe(1);
  });
});

/* ───────────────────── 落盘：原子写 + 旧数据回读 ───────────────────── */

const ROOT = mkdtempSync(path.join(os.tmpdir(), "c1-jsonstore-"));
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

let n = 0;
/** 每次都换一个干净的子目录 —— 目录一起建好，免得"文件写不进去"和"目录不存在"混成一个假失败。 */
const tmpFile = (): string => {
  const dir = path.join(ROOT, `case-${(n += 1)}`);
  mkdirSync(dir, { recursive: true });
  return path.join(dir, "lib.json");
};

describe("createJsonStore", () => {
  /*
   * ⚠️ 这一组测的是**文件后端**的机制（磁盘上那个信封长什么样、不留 .tmp、
   * 版本号取自 SCHEMA_VERSION）—— 所以固定走回退开关那条路。
   * 从 Phase 12.1 起默认后端是 SQLite KV，那条路在 `src/kvStores.test.ts`。
   */
  process.env.DSH_STORE_BACKEND = "file";
  afterAll(() => {
    delete process.env.DSH_STORE_BACKEND;
  });

  const migrations = { 0: (old: unknown) => ({ items: Array.isArray(old) ? old : [] }) };
  const makeStore = (file: string) =>
    createJsonStore<{ items: string[] }>({
      file: () => file,
      initial: () => ({ items: [] }),
      normalize: (v) => {
        const o = (v ?? {}) as { items?: unknown };
        return { items: Array.isArray(o.items) ? o.items.map(String) : [] };
      },
      version: 1,
      migrations,
    });

  it("写出去的是带版本的信封，且**不残留 .tmp**", async () => {
    const file = tmpFile();
    const store = makeStore(file);
    const res = await store.write({ items: ["一", "二"] });
    expect(res.ok).toBe(true);

    const onDisk = JSON.parse(readFileSync(file, "utf8")) as { __schema: number; data: unknown };
    expect(onDisk.__schema).toBe(1);
    expect(onDisk.data).toEqual({ items: ["一", "二"] });
    expect(readdirSync(path.dirname(file)).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });

  it("⭐ 磁盘上是**裸 JSON**（旧格式）也能读出来，并且标记 migrated", async () => {
    const file = tmpFile();
    writeFileSync(file, JSON.stringify(["旧一", "旧二"]), "utf8");
    const got = await makeStore(file).read();
    expect(got.data).toEqual({ items: ["旧一", "旧二"] });
    expect(got.from).toBe(0);
    expect(got.migrated).toBe(true);
    expect(got.foreign).toBe(false);
  });

  it("文件不存在 → 兜底值，不算错误", async () => {
    const got = await makeStore(tmpFile()).read();
    expect(got.data).toEqual({ items: [] });
    expect(got.foreign).toBe(false);
  });

  it("坏 JSON → 兜底值，不抛（坏文件不许把应用卡住）", async () => {
    const file = tmpFile();
    writeFileSync(file, "{ 这不是 json", "utf8");
    const got = await makeStore(file).read();
    expect(got.data).toEqual({ items: [] });
  });

  it("⚠️ 版本更新 → foreign=true，调用方据此不许回写", async () => {
    const file = tmpFile();
    writeFileSync(file, JSON.stringify(wrap({ items: ["未来"] }, 99)), "utf8");
    const got = await makeStore(file).read();
    expect(got.foreign).toBe(true);
    expect(got.note).toContain("99");
  });

  it("写不进去时返回 ok:false 并给出原因（且不留 .tmp）", async () => {
    // 让父目录是一个**文件**，mkdir/write 必然失败，且重试也救不了
    const blocker = path.join(ROOT, "blocker");
    writeFileSync(blocker, "我是文件不是目录", "utf8");
    const store = makeStore(path.join(blocker, "sub", "lib.json"));
    const res = await store.write({ items: ["x"] });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(typeof res.error).toBe("string");
    expect(res.error.length).toBeGreaterThan(0);
    /*
     * ⚠️ 2026-10-16（审计 G53.f）：用例名写着"**且不留 .tmp**"，可原来体内没有这一条
     * （同文件另一条才验）—— 也就是把一个没验的性质写进了名字。失败的写入路径最容易
     * 在半路留下临时文件（原子写 = 先写 .tmp 再改名），所以这里真数一遍。
     */
    const left = readdirSync(ROOT).filter((f) => f.endsWith(".tmp"));
    expect(left, `失败的写入留下了临时文件：${left.join(", ")}`).toEqual([]);
  });

  it("版本号：默认取 SCHEMA_VERSION，**显式给了就用给的**", async () => {
    /*
     * ⚠️ 2026-10-16（审计 G53.e）：原来只验"没传 version 时写下去等于 SCHEMA_VERSION" ——
     * 而落盘那一行本身就是 `opts.version ?? SCHEMA_VERSION`，这条**恒真**（传了 version
     * 被忽略也照样绿）。补上真正有判别力的那一半：显式给 7，盘上就必须是 7。
     */
    const file = tmpFile();
    const store = createJsonStore<string[]>({
      file: () => file,
      initial: () => [],
      normalize: (v) => (Array.isArray(v) ? v.map(String) : []),
    });
    await store.write(["x"]);
    const onDisk = JSON.parse(readFileSync(file, "utf8")) as { __schema: number };
    expect(onDisk.__schema).toBe(SCHEMA_VERSION);

    const pinned = tmpFile();
    const custom = createJsonStore<string[]>({
      file: () => pinned,
      initial: () => [],
      normalize: (v) => (Array.isArray(v) ? v.map(String) : []),
      version: 7,
    });
    await custom.write(["y"]);
    const customDisk = JSON.parse(readFileSync(pinned, "utf8")) as { __schema: number };
    expect(customDisk.__schema, "显式指定的 version 被忽略了").toBe(7);
  });
});
