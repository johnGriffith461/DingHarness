import { describe, expect, it } from "vitest";
import {
  CONTENT_KEYS,
  appendVersion,
  extractContent,
  readMeta,
  seedGeneration,
  stripGeneration,
  versionIndex,
  versionPatch,
} from "./generation";
import type { GenerationNode } from "./generation";

const markdownNode: GenerationNode = {
  id: "n1",
  type: "markdown",
  data: { text: "第一版内容", title: "标题" },
};

const codeNode: GenerationNode = {
  id: "n2",
  type: "code",
  data: { code: "const a = 1;", lang: "ts", title: "片段" },
};

describe("extractContent", () => {
  it("只取该类型的内容字段，不带上标题等元信息", () => {
    expect(extractContent(markdownNode)).toEqual({ text: "第一版内容" });
    expect(extractContent(codeNode)).toEqual({ code: "const a = 1;", lang: "ts" });
  });

  it("未知类型返回空对象（不会误把整份 data 当内容）", () => {
    expect(extractContent({ id: "x", type: "unknown", data: { a: 1 } })).toEqual({});
  });

  it("内容里缺字段时跳过，不塞 undefined", () => {
    expect(extractContent({ id: "x", type: "code", data: { code: "x" } })).toEqual({ code: "x" });
  });
});

describe("seedGeneration", () => {
  it("首版内容就是节点当前内容，状态默认 done", () => {
    const meta = seedGeneration(markdownNode, "gpt-4o-mini", { prompt: "写一段" });
    expect(meta.versions).toHaveLength(1);
    expect(meta.status).toBe("done");
    expect(meta.prompt).toBe("写一段");
    expect(meta.activeVersion).toBe(meta.versions[0].id);
    expect(meta.versions[0].content).toEqual({ text: "第一版内容" });
    expect(meta.contentKeys).toEqual(CONTENT_KEYS.markdown);
  });

  it("可以带上失败状态（用于失败留痕）", () => {
    const meta = seedGeneration(markdownNode, "m", { status: "failed" });
    expect(meta.status).toBe("failed");
  });
});

describe("appendVersion", () => {
  it("追加后总数 +1，并把当前版指向最新", () => {
    const first = seedGeneration(markdownNode, "m1");
    const withMeta: GenerationNode = {
      ...markdownNode,
      data: { ...markdownNode.data, generation: first },
    };
    const second = appendVersion(withMeta, "m2");

    expect(second.versions).toHaveLength(2);
    expect(second.activeVersion).toBe(second.versions[1].id);
    expect(second.versions[1].model).toBe("m2");
    // prompt 要沿袭下来，否则"重试"会丢上下文
    expect(second.prompt).toBe(first.prompt);
  });

  it("没有历史时也能当首版用", () => {
    const meta = appendVersion(markdownNode, "manual");
    expect(meta.versions).toHaveLength(1);
    expect(meta.status).toBe("done");
  });
});

describe("versionPatch / versionIndex", () => {
  it("能按版本 id 取出内容补丁", () => {
    const first = seedGeneration(markdownNode, "m1");
    const node: GenerationNode = { ...markdownNode, data: { ...markdownNode.data, generation: first } };
    const patch = versionPatch(node, first.versions[0].id);
    expect(patch).toEqual({ text: "第一版内容" });
  });

  it("版本不存在时返回 null", () => {
    const first = seedGeneration(markdownNode, "m1");
    const node: GenerationNode = { ...markdownNode, data: { ...markdownNode.data, generation: first } };
    expect(versionPatch(node, "not-exist")).toBeNull();
  });

  it("版本序号从 1 开始，找不到为 0", () => {
    const first = seedGeneration(markdownNode, "m1");
    const node: GenerationNode = { ...markdownNode, data: { ...markdownNode.data, generation: first } };
    expect(versionIndex(node, first.versions[0].id)).toBe(1);
    expect(versionIndex(node, "nope")).toBe(0);
  });
});

describe("readMeta / stripGeneration", () => {
  it("没有生成信息时返回 undefined", () => {
    expect(readMeta(markdownNode)).toBeUndefined();
  });

  it("stripGeneration 只摘掉 generation，内容字段保留", () => {
    const first = seedGeneration(markdownNode, "m1");
    const data = { ...markdownNode.data, generation: first };
    const stripped = stripGeneration(data as never) as unknown as Record<string, unknown>;
    expect(stripped["generation"]).toBeUndefined();
    expect(stripped["text"]).toBe("第一版内容");
  });
});
