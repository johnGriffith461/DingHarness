import { describe, expect, it } from "vitest";
import { GENERATION_VERSION_LIMIT, appendVersion, readMeta } from "./generation";
import type { GenerationNode } from "./generation";

/**
 * 生成版本的条数上限（2026-10-16，审计 **P259**）。
 *
 * ## 钉住的是哪件事
 *
 * `appendVersion` 每版存的是**整份内容快照**，而它原来**没有条数上限**。
 * 对同一个大节点反复「再来一次 / 润色」时，节点 data 里会累积出与重生成次数成正比的全文，
 * 而这份 data 会跟着画布 JSON 落盘、进备份包、被每次 `commitHistory` 的整图快照引用 ——
 * 用户看不到任何提示，只是应用越用越重。
 *
 * ## 判据（含"保留首版"这条口径）
 *
 *   · 不超过上限时**一版都不许少**（别为了防涨把正常历史丢了）；
 *   · 超过之后**总数封顶**、**当前版一定在**、**第一版一定还在**（它是"最初那个内容"）。
 *
 * ## 变异实证
 *
 * 把 `capVersions([...])` 换回直接传入数组（即 `const versions = [...]`）→ 第一个用例红。
 */

function nodeWith(text: string): GenerationNode {
  return { id: "n1", type: "markdown", data: { text, generation: seedMeta() } };
}

/** 一个只有首版的初始 meta（模拟"第一次生成之后"）。 */
function seedMeta() {
  const node: GenerationNode = { id: "n1", type: "markdown", data: { text: "第一版" } };
  return appendVersion(node, "m0");
}

describe("生成版本上限（P259）", () => {
  it("⭐ 反复重生成之后，版本数封顶，且当前版与首版都在", () => {
    const node = nodeWith("第一版");
    let meta = seedMeta();
    const first = meta.versions[0]?.id;
    expect(first).toBeTruthy();

    for (let i = 0; i < GENERATION_VERSION_LIMIT * 2; i += 1) {
      const cur: GenerationNode = { ...node, data: { text: `第 ${i} 版`, generation: meta } };
      meta = appendVersion(cur, `m${i}`);
    }

    expect(meta.versions.length, "条数必须封顶（否则重生成 40 次就是 40 份全文）").toBe(
      GENERATION_VERSION_LIMIT,
    );
    expect(meta.versions[0]?.id, "首版（最初那个内容）必须留着").toBe(first);
    expect(meta.activeVersion, "当前版必须还在列表里").toBe(meta.versions[meta.versions.length - 1]?.id);
    expect(meta.versions.at(-1)?.content).toEqual({ text: "第 39 版" });
  });

  it("没到上限时一版都不许丢（别把正常历史裁掉）", () => {
    const node = nodeWith("第一版");
    let meta = seedMeta();
    for (let i = 0; i < 5; i += 1) {
      const cur: GenerationNode = { ...node, data: { text: `第 ${i} 版`, generation: meta } };
      meta = appendVersion(cur, `m${i}`);
    }
    expect(meta.versions.length).toBe(6);
    expect(readMeta({ data: { generation: meta } })?.versions.length).toBe(6);
  });
});
