import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SCHEMA_VERSION, wrap } from "@shared/persist";

/**
 * C1：主进程那 6 个 json store 的**接线**必须被钉住。
 *
 * ## 为什么这条必须存在
 *
 * C1 把 12 份各写一遍的"读 json / 写 json"收成了一份（`electron/ipc/jsonStore.ts`），
 * 机器本身在 `persist.test.ts` 里测透了 —— 但**"哪个 store 真的接上了它"没有任何断言**。
 * 而没有断言的机制就是没有：下一个模块只要照抄旁边那份**旧**写法，
 * 保证就悄悄退回"不重试、无版本"，而且**测试照样全绿**（这正是本项目反复清的那类东西，
 * 见 §5.2 "文档里的 ✅ 不可信"）。
 *
 * ## 怎么做到的：把 `electron` mock 掉
 *
 * 这 6 个 store 只从 electron 拿两样东西：`app.getPath("userData")`（决定文件落哪）
 * 和 `ipcMain`（注册通道）。把这两样换成**临时目录**，主进程的落盘就成了可直测的纯 IO ——
 * 而这批文件原本**一条测试覆盖都没有**。
 *
 * ⚠️ 断言的是**真的读写磁盘**之后的结果（信封长什么样、旧文件读不读得出来、
 * 更新的版本有没有被覆盖），不是"函数被调过"。
 */

const env = vi.hoisted(() => ({ userData: "" }));

vi.mock("electron", () => ({
  app: { getPath: () => env.userData },
  ipcMain: { handle: () => undefined, removeHandler: () => undefined },
  powerSaveBlocker: { isStarted: () => false, start: () => 1, stop: () => undefined },
}));

import { loadAgents, saveAgents } from "../electron/ipc/agentStore";
import { loadAppSettings, saveAppSettings, appSettingsPath } from "../electron/ipc/appSettings";
import { codingLikesPath, loadLiked, saveLiked } from "../electron/ipc/codingStore";
import { loadDocs, saveDocs } from "../electron/ipc/docStore";
import { libraryPath, loadLibrary, saveLibrary } from "../electron/ipc/libraryStore";
import { readMemory, writeMemory } from "../electron/ipc/memoryStore";
import { loadReadings, saveReadings } from "../electron/ipc/readerStore";
import { loadAllowConnect, saveAllowConnect } from "../electron/ipc/remote";
import { loadJobs, saveJobs, schedulesPath } from "../electron/ipc/scheduleStore";
import { loadSearchHistory, saveSearchHistory } from "../electron/ipc/searchStore";
import { loadTasks, saveTasks, tasksPath } from "../electron/ipc/taskStore";
import type { CronJob } from "@shared/schedule";

/** 该 store 的落盘文件（路径与各 store 里的 `filePath()` 一致）。 */
function fileOf(name: string): string {
  return path.join(env.userData, name);
}

/** 磁盘上的原始内容（用来验"没被覆盖"）。 */
function rawOf(name: string): string {
  return readFileSync(fileOf(name), "utf8");
}

/** 目录里残留的 `.tmp`（原子写正常收尾时必须是空的）。 */
function tempLeftovers(): string[] {
  return readdirSync(env.userData).filter((f) => f.endsWith(".tmp"));
}

beforeEach(() => {
  env.userData = mkdtempSync(path.join(os.tmpdir(), "dwc-ipcstore-"));
});

afterEach(() => {
  rmSync(env.userData, { recursive: true, force: true });
});

describe("AI 文档（docs.json）", () => {
  it("往返：写出去是带版本的信封，读回来是同一份东西，且不留 .tmp", async () => {
    const saved = await saveDocs([{ id: "d1", title: "标题", body: "正文", createdAt: 1, updatedAt: 2 }]);
    expect(saved.map((d) => d.id)).toEqual(["d1"]);

    const onDisk = JSON.parse(rawOf("docs.json")) as { __schema: number; data: { id: string }[] };
    expect(onDisk.__schema).toBe(SCHEMA_VERSION);
    expect(onDisk.data[0].id).toBe("d1");

    const back = await loadDocs();
    expect(back.map((d) => d.id)).toEqual(["d1"]);
    expect(back[0].body).toBe("正文");
    expect(tempLeftovers()).toEqual([]);
  });

  it("⭐ 磁盘上的裸数组（信封上线之前的格式）照样读得出来", async () => {
    writeFileSync(fileOf("docs.json"), JSON.stringify([{ id: "old", title: "旧文档", body: "x", updatedAt: 5 }]), "utf8");

    const back = await loadDocs();
    expect(back.map((d) => d.id)).toEqual(["old"]);
    expect(back[0].title).toBe("旧文档");
  });

  it("⚠️ 磁盘上是**更新的版本** → 拒绝覆盖（用户写的文档不许被降级销毁）", async () => {
    writeFileSync(fileOf("docs.json"), JSON.stringify(wrap([{ id: "future" }], 99)), "utf8");
    const before = rawOf("docs.json");

    await saveDocs([{ id: "mine" }]);

    expect(rawOf("docs.json")).toBe(before);
  });
});

describe("最近阅读（readings.json）", () => {
  it("往返 + 收窄在落盘时就生效（只留最近 20 条，新的在前）", async () => {
    const many = Array.from({ length: 25 }, (_, i) => ({ id: `r${i}`, text: `第 ${i} 段`, at: i }));
    await saveReadings(many);

    expect((JSON.parse(rawOf("readings.json")) as { __schema: number }).__schema).toBe(SCHEMA_VERSION);
    const back = await loadReadings();
    expect(back).toHaveLength(20);
    expect(back[0].id).toBe("r24");
  });

  it("⭐ 旧格式（裸数组）读得出来；坏条目被丢掉而不是让读入整个失败", async () => {
    writeFileSync(
      fileOf("readings.json"),
      JSON.stringify([{ id: "ok", text: "正文", at: 1 }, { id: "坏", nope: 1 }, "根本不是对象"]),
      "utf8",
    );

    const back = await loadReadings();
    expect(back.map((r) => r.id)).toEqual(["ok"]);
  });
});

describe("搜索历史（search-history.json）", () => {
  it("往返 + 太短与重复的条目在落盘时就被丢掉", async () => {
    await saveSearchHistory({ skills: ["react", "a", "React", "react"], files: ["report.md"] });

    expect((JSON.parse(rawOf("search-history.json")) as { __schema: number }).__schema).toBe(SCHEMA_VERSION);
    const back = await loadSearchHistory();
    expect(back.skills).toEqual(["react"]);
    expect(back.files).toEqual(["report.md"]);
  });

  it("⭐ 旧格式（裸对象）读得出来", async () => {
    writeFileSync(fileOf("search-history.json"), JSON.stringify({ skills: ["画布"], files: [] }), "utf8");

    const back = await loadSearchHistory();
    expect(back.skills).toEqual(["画布"]);
  });
});

describe("智能体（agents.json）", () => {
  it("往返：智能体与「当前选中的」一起落盘、一起读回", async () => {
    await saveAgents({ agents: [{ id: "a1", name: "小助手" }], selected: "a1" });

    const onDisk = JSON.parse(rawOf("agents.json")) as { __schema: number; data: { selected: string } };
    expect(onDisk.__schema).toBe(SCHEMA_VERSION);
    expect(onDisk.data.selected).toBe("a1");

    const back = await loadAgents();
    expect(back.agents.map((a) => a.id)).toEqual(["a1"]);
    expect(back.selected).toBe("a1");
  });

  it("⭐ 更早的形状（裸数组、没有选中项）也能读出来", async () => {
    writeFileSync(fileOf("agents.json"), JSON.stringify([{ id: "a1", name: "老智能体" }]), "utf8");

    const back = await loadAgents();
    expect(back.agents.map((a) => a.name)).toEqual(["老智能体"]);
    expect(back.selected).toBe("");
  });

  it("选中的那个已经不在库里 → 当作没选（不留下指向不存在智能体的 id）", async () => {
    await saveAgents({ agents: [{ id: "a1", name: "小助手" }], selected: "已经删掉的" });
    expect((await loadAgents()).selected).toBe("");
  });
});

describe("应用设置（settings.json）", () => {
  /** 路径取自模块自己导出的函数：硬编文件名的话，改了名字这里会静默测到别处去。 */
  const raw = (): string => readFileSync(appSettingsPath(), "utf8");

  it("⭐ 旧格式（裸对象）读得出来；坏值被收窄成默认", async () => {
    writeFileSync(appSettingsPath(), JSON.stringify({ pinnedModel: "deepseek/deepseek-chat" }), "utf8");
    expect(await loadAppSettings()).toEqual({ pinnedModel: "deepseek/deepseek-chat" });

    writeFileSync(appSettingsPath(), JSON.stringify({ pinnedModel: 42 }), "utf8");
    expect(await loadAppSettings()).toEqual({ pinnedModel: "" });
  });

  it("往返 + 落盘带信封", async () => {
    expect(await saveAppSettings({ pinnedModel: "deepseek/deepseek-reasoner" })).toEqual({
      pinnedModel: "deepseek/deepseek-reasoner",
    });
    expect((JSON.parse(raw()) as { __schema: number }).__schema).toBe(SCHEMA_VERSION);
    expect(await loadAppSettings()).toEqual({ pinnedModel: "deepseek/deepseek-reasoner" });
  });

  it("⚠️ 磁盘上是更新的版本 → 拒绝覆盖", async () => {
    writeFileSync(appSettingsPath(), JSON.stringify(wrap({ pinnedModel: "future/model" }, 99)), "utf8");
    const before = raw();

    await saveAppSettings({ pinnedModel: "deepseek/deepseek-chat" });

    expect(raw()).toBe(before);
  });
});

describe("远端控制许可（remote.json）", () => {
  it("⭐ 默认是**允许**：没有文件、坏文件、字段缺失都算 true（不能变成默认拒绝）", async () => {
    expect(await loadAllowConnect()).toBe(true);

    writeFileSync(fileOf("remote.json"), "{ 这不是 json", "utf8");
    expect(await loadAllowConnect()).toBe(true);

    writeFileSync(fileOf("remote.json"), JSON.stringify({ 别的字段: 1 }), "utf8");
    expect(await loadAllowConnect()).toBe(true);
  });

  it("往返：关掉之后读回来是关着的", async () => {
    expect(await saveAllowConnect(false)).toBe(true);
    expect(await loadAllowConnect()).toBe(false);

    // 显式写的 false 与"字段缺失"必须区分开 —— 这正是上面那条默认的边界
    expect((JSON.parse(rawOf("remote.json")) as { data: { allowConnect: boolean } }).data.allowConnect).toBe(false);
  });
});

describe("工作台任务（tasks.json）· C1 之前就已收编的几个", () => {
  it("往返 + 落盘带信封", async () => {
    await saveTasks([{ id: "t1", title: "置顶的任务" }]);

    expect((JSON.parse(readFileSync(tasksPath(), "utf8")) as { __schema: number }).__schema).toBe(SCHEMA_VERSION);
    expect(await loadTasks()).toEqual([{ id: "t1", title: "置顶的任务" }]);
  });

  it("⭐ 磁盘上的裸数组（旧格式）读得出来", async () => {
    writeFileSync(tasksPath(), JSON.stringify([{ id: "old", pinned: true }]), "utf8");
    expect(await loadTasks()).toEqual([{ id: "old", pinned: true }]);
  });

  it("⚠️ 磁盘上是更新的版本 → 拒绝覆盖，并如实返回「否」", async () => {
    writeFileSync(tasksPath(), JSON.stringify(wrap([{ id: "future" }], 99)), "utf8");

    expect(await saveTasks([{ id: "mine" }])).toBe(false);
    expect(JSON.parse(rawOf("tasks.json")).data).toEqual([{ id: "future" }]);
  });
});

describe("定时任务（schedules.json）", () => {
  it("往返（主进程只做最小收窄：是个带 id 的对象就留）", async () => {
    const job = { id: "j1", repeat: "daily" } as unknown as CronJob;
    expect(await saveJobs([job])).toBe(true);

    expect((JSON.parse(readFileSync(schedulesPath(), "utf8")) as { __schema: number }).__schema).toBe(SCHEMA_VERSION);
    expect(await loadJobs()).toEqual([job]);
  });

  it("⭐ 旧格式（裸数组）读得出来；没有 id 的条目被丢掉", async () => {
    writeFileSync(schedulesPath(), JSON.stringify([{ id: "j1" }, { 没有id: 1 }, null]), "utf8");
    expect(await loadJobs()).toEqual([{ id: "j1" }]);
  });
});

describe("本机库（library.json）", () => {
  it("往返；不是对象的落盘值一律当空库（免得手改过的文件传下去在渲染层炸）", async () => {
    expect(await saveLibrary({ plugins: { a: { on: true } } })).toBe(true);
    expect((JSON.parse(readFileSync(libraryPath(), "utf8")) as { __schema: number }).__schema).toBe(SCHEMA_VERSION);
    expect(await loadLibrary()).toEqual({ plugins: { a: { on: true } } });

    writeFileSync(libraryPath(), JSON.stringify(["不是对象"]), "utf8");
    expect(await loadLibrary()).toEqual({});
  });
});

describe("创作广场的喜欢名单（coding-likes.json）", () => {
  it("往返 + 落盘带信封", async () => {
    expect(await saveLiked(["应用甲", "应用乙"])).toBe(true);
    expect(await loadLiked()).toEqual(["应用甲", "应用乙"]);

    const onDisk = JSON.parse(readFileSync(codingLikesPath(), "utf8")) as { data: { liked: string[] } };
    expect(onDisk.data.liked).toEqual(["应用甲", "应用乙"]);
  });

  it("⭐ 旧格式（裸数组，没有外壳对象）也读得出来", async () => {
    writeFileSync(codingLikesPath(), JSON.stringify(["旧的喜欢"]), "utf8");
    expect(await loadLiked()).toEqual(["旧的喜欢"]);
  });
});

describe("记忆库（memory.json）", () => {
  /** 一条能过 `normalizeMemory` 的最小记忆（`text` 与 `id` 都必需）。 */
  const entry = { id: "m1", text: "主人喜欢美式", createdAt: "2026-01-01T00:00:00.000Z", source: "manual" };

  it("往返 + 落盘带信封", async () => {
    await writeMemory({ entries: [entry] });

    expect((JSON.parse(rawOf("memory.json")) as { __schema: number }).__schema).toBe(SCHEMA_VERSION);
    expect((await readMemory()).entries.map((e) => e.text)).toEqual(["主人喜欢美式"]);
  });

  it("⚠️ `enabled:false` 必须一起回来（§182：关掉记忆重启后又自己开回来是用户看得见的 bug）", async () => {
    await writeMemory({ entries: [entry], enabled: false });
    expect((await readMemory()).enabled).toBe(false);
  });

  it("⭐ 磁盘上的裸对象（旧格式）读得出来", async () => {
    writeFileSync(fileOf("memory.json"), JSON.stringify({ entries: [entry] }), "utf8");
    expect((await readMemory()).entries).toHaveLength(1);
  });
});

describe("结构守卫：JSON 落盘不许再有第二份手写", () => {
  const ROOT = path.resolve(__dirname, "..");

  /**
   * 允许自己手写 JSON 落盘的地方，**每一条都要有理由**。
   *
   * - `snapshotStore`：写的是画布文档 + 按 revision 命名的历史快照，带一套
   *   "revision 倒退就拒绝"的冲突规则，且调用方是**同步**函数 —— 收编要连带改画布调用链，
   *   属于 C1 之外的动作（越界清单里 `src/canvas/` 只许在 A3 / 阶段 E 动）。
   * - `aiProbe`：探测缓存**是**一处该收编的真缺陷（无归一化、非原子写），
   *   但它的读路径被一个**同步** API（`listProvidersWithProbe`，`ai.ts:80` 直接返回）
   *   用着，改成异步会让"读-改-写"出现交错 —— 同一轮里 `markProviderOk` 与
   *   `markProviderFailed` 都是**即发即忘**地写同一个文件，交错就是丢条目。
   *   要收编得先给它加一条写队列，那不是这一项活的范围。
   */
  const ALLOWED = new Set(["snapshotStore.ts", "aiProbe.ts"]);

  /**
   * 在源码里找出"手写 JSON 落盘"的行。
   *
   * 判定刻意收窄成**同一条语句**：`writeFileSync(...JSON.stringify...)`。
   * 只按"这个文件里同时出现了 `writeFileSync` 和 `JSON.stringify`"来判会误报两类
   * 完全正当的代码：注释里提到旧写法（`memoryStore` 的说明）、
   * 以及"写二进制 + 另有一处序列化 HTTP body"（`imageGen`）。
   *
   * ⚠️ 这是**触发器不是证明**：把 `writeFileSync` 与 `JSON.stringify` 拆到两行就能绕过。
   * 它要拦的是"照抄旁边那份旧写法"这种**顺手**动作，真正的证据是上面那些往返测试。
   *
   * @param src 源码
   * @returns 命中的行（去掉注释之后）
   */
  function handRolledJsonWrites(src: string): string[] {
    const noComments = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    return noComments
      .split("\n")
      .filter((line) => line.includes("writeFileSync(") && line.includes("JSON.stringify"));
  }

  function tsFiles(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules") continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) tsFiles(full, out);
      else if (entry.name.endsWith(".ts")) out.push(full);
    }
    return out;
  }

  it("判定本身有效（注释与二进制写不许被误判，真手写必须被抓到）", () => {
    expect(handRolledJsonWrites('// 原来是 fs.writeFileSync(p, JSON.stringify(x))')).toEqual([]);
    expect(handRolledJsonWrites("/* fs.writeFileSync(p, JSON.stringify(x)) */")).toEqual([]);
    expect(handRolledJsonWrites("fs.writeFileSync(path.join(dir, name), buf)")).toEqual([]);
    expect(handRolledJsonWrites("fs.writeFileSync(p, JSON.stringify(x, null, 2))")).toHaveLength(1);
  });

  it("electron/ 下凡是手写 JSON 落盘的地方，只能是明列的例外", () => {
    const offenders: string[] = [];
    for (const file of tsFiles(path.join(ROOT, "electron"))) {
      const base = path.basename(file);
      if (base === "jsonStore.ts") continue; // 这就是那一份实现
      if (handRolledJsonWrites(readFileSync(file, "utf8")).length > 0 && !ALLOWED.has(base)) {
        offenders.push(path.relative(ROOT, file).replace(/\\/g, "/"));
      }
    }
    expect(
      offenders,
      `这些文件在手写 JSON 落盘 —— 请改用 electron/ipc/jsonStore.ts（原子写 + 重试 + 信封版本）：\n${offenders.join("\n")}`,
    ).toEqual([]);
  });

  it("例外仍在（`ALLOWED` 不许变成「列着已经不存在的文件」的空名单）", () => {
    const names = new Set(tsFiles(path.join(ROOT, "electron")).map((f) => path.basename(f)));
    for (const allowed of ALLOWED) expect(names.has(allowed)).toBe(true);
  });

  it("守卫自己别成了空扫描（否则上面那条永远是绿的）", () => {
    expect(tsFiles(path.join(ROOT, "electron")).length).toBeGreaterThan(20);
  });
});
