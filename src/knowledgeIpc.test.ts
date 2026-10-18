import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { removeAll } from "./testFs";

/**
 * **桌面知识库 IPC**（G15）的接线守卫。
 *
 * 判据是"走同一条真实库"：
 * ① 粘贴一段 → 列表里有、搜得到；
 * ② 导入一个临时文本文件 → 文档落库（不是只回一个 ok）；
 * ③ 二进制 / 超限 → 拒，且说明原因；
 * ④ 删除之后搜不到；
 * ⑤ 与 `ding knowledge` 同一个库文件（路径来自 `app.getPath("userData")`）。
 */

const env = vi.hoisted(() => ({ userData: "", picked: "" as string | false }));

vi.mock("electron", () => ({
  app: { getPath: () => env.userData },
  dialog: {
    showOpenDialog: async () =>
      env.picked === false ? { canceled: true, filePaths: [] } : { canceled: false, filePaths: [env.picked] },
  },
}));

type Handler = (...args: unknown[]) => unknown;
const handlers = new Map<string, Handler>();
const fakeIpc = {
  handle: (channel: string, fn: Handler) => handlers.set(channel, fn),
} as unknown as Electron.IpcMain;

let dir = "";

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "dh-knowledge-ipc-"));
  env.userData = dir;
  env.picked = false;
  handlers.clear();
});

afterEach(() => {
  removeAll(dir);
});

const { registerKnowledgeIpc, KNOWLEDGE_MAX_BYTES } = await import("../electron/ipc/knowledge");

function call<T>(channel: string, ...args: unknown[]): T {
  const fn = handlers.get(channel);
  if (!fn) throw new Error(`没有注册 ${channel}`);
  return fn(...args) as T;
}

describe("G15：知识库 IPC", () => {
  it("粘贴一段 → 列表有、搜得到、删除后搜不到", () => {
    registerKnowledgeIpc(fakeIpc, () => ({} as never));
    const added = call<{ ok: boolean; doc: { id: string; title: string; chunks: number } }>(
      "knowledge:add-text",
      undefined,
      { title: "季度目标", text: "Q4 的重点是把启动时间压到一秒以内。", domain: "private" },
    );
    expect(added.ok).toBe(true);
    expect(added.doc.chunks).toBeGreaterThan(0);

    const listed = call<{ docs: Array<{ title: string }>; file: string }>("knowledge:list");
    expect(listed.docs.map((d) => d.title)).toContain("季度目标");
    expect(listed.file.replace(/\\/g, "/")).toContain("knowledge.db");

    const found = call<{ hits: Array<{ title: string; citation: string; text: string }> }>(
      "knowledge:search",
      undefined,
      "启动时间",
    );
    expect(found.hits.length).toBeGreaterThan(0);
    expect(found.hits[0]!.text).toContain("启动时间");
    expect(found.hits[0]!.citation).toContain("季度目标");

    const removed = call<{ removed: number }>("knowledge:remove", undefined, added.doc.id);
    expect(removed.removed).toBe(1);
    expect(call<{ hits: unknown[] }>("knowledge:search", undefined, "启动时间").hits).toHaveLength(0);
  });

  it("导入文本文件 → 落库；取消 → canceled（不当作失败）", async () => {
    registerKnowledgeIpc(fakeIpc, () => ({} as never));
    const file = path.join(dir, "会议纪要.md");
    writeFileSync(file, "# 会议纪要\n\n决定：周五前完成迁移验证。\n", "utf8");
    env.picked = file;

    const got = (await call<Promise<{ ok: boolean; doc?: { title: string } }>>("knowledge:add-file")) as {
      ok: boolean;
      doc?: { title: string };
    };
    expect(got.ok).toBe(true);
    expect(got.doc?.title).toBe("会议纪要.md");
    expect(call<{ hits: Array<{ text: string }> }>("knowledge:search", undefined, "迁移验证").hits.length).toBeGreaterThan(0);

    env.picked = false;
    const canceled = (await call<Promise<{ ok: boolean; canceled?: boolean }>>("knowledge:add-file")) as {
      ok: boolean;
      canceled?: boolean;
    };
    expect(canceled).toMatchObject({ ok: false, canceled: true });
  });

  it("二进制 / 超限 / 空标题都被拒，且给出人话", async () => {
    registerKnowledgeIpc(fakeIpc, () => ({} as never));

    const binary = path.join(dir, "bin.dat");
    writeFileSync(binary, Buffer.from([0x00, 0x01, 0x02, 0x03]), "utf8");
    env.picked = binary;
    const gotBin = (await call<Promise<{ ok: boolean; error?: string }>>("knowledge:add-file")) as {
      ok: boolean;
      error?: string;
    };
    expect(gotBin.ok).toBe(false);
    /* 先被扩展名挡住（.dat 不在名单里）—— 这本身就是判据 */
    expect(gotBin.error).toBeTruthy();

    const empty = call<{ ok: boolean; error?: string }>("knowledge:add-text", undefined, { title: "", text: "x" });
    expect(empty.ok).toBe(false);

    const tooBig = call<{ ok: boolean; error?: string }>("knowledge:add-text", undefined, {
      title: "太大",
      text: "字".repeat(KNOWLEDGE_MAX_BYTES),
    });
    expect(tooBig.ok).toBe(false);
    expect(tooBig.error).toContain("MB");
  });
});

/**
 * 装配对账：工具、桥、界面三处都要有，缺一处功能就"看起来有"。
 */
describe("G15：装配对账", () => {
  const root = path.resolve(__dirname, "..");
  const read = (rel: string) => readFileSync(path.join(root, rel), "utf8");

  it("桌面执行体里有 knowledge_search 分支（工具声明了要能执行）", () => {
    const tools = read("electron/ipc/tools.ts");
    expect(tools).toContain("KNOWLEDGE_SEARCH_TOOL");
    expect(tools, "声明在 AGENT_TOOLS 里却没有执行分支 —— 模型调到它只会拿到「没有这个工具」").toMatch(
      /\[KNOWLEDGE_SEARCH_TOOL\]:/,
    );
  });

  it("preload 把知识库桥出去，主进程注册了它", () => {
    expect(read("electron/preload.ts")).toContain("KNOWLEDGE_CHANNEL");
    expect(read("electron/main.ts")).toContain("registerKnowledgeIpc");
  });

  it("设置里有知识库入口（不然只有命令能用）", () => {
    const dialog = read("src/workbench/SettingsDialog.tsx");
    expect(dialog).toContain('label: "知识库"');
    expect(read("src/workbench/SettingsPages.tsx")).toContain("<KnowledgePage />");
  });

  it("线上形状与引擎的字段对得上（抄形状必须有守卫）", () => {
    const store = read("engine/rag/store.ts");
    const docBody = /export type KnowledgeDoc = \{([\s\S]*?)\n\};/.exec(store)?.[1] ?? "";
    const docKeys = [...docBody.matchAll(/^\s{2}([a-zA-Z]+):/gm)].map((m) => m[1]!);
    expect(docKeys.length).toBeGreaterThan(3);
    const wire = read("shared/knowledgeWire.ts");
    const wireBody = /export type KnowledgeDocWire = \{([\s\S]*?)\n\};/.exec(wire)?.[1] ?? "";
    /* sha 是内容指纹，界面不用（也不该把它当身份）；其余字段必须对上 */
    for (const key of docKeys.filter((k) => k !== "sha")) {
      expect(wireBody, `引擎有 ${key}、线上形状没有 —— 界面永远看不到它`).toContain(`${key}:`);
    }
  });
});
