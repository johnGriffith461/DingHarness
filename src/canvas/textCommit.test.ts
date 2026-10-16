import { describe, expect, it } from "vitest";
import { createEditBuffer, shouldCommitOnEnter } from "./textCommit";

/**
 * 编辑态落盘的两条口径（2026-10-16 审计 P27 / P28）。
 *
 *   · P27 形状文字 / HTML 源码只在 blur 提交，而画布开着 `onlyRenderVisibleElements` ——
 *     节点被滚出视野/画布面板一关就**卸载**，blur 永远不来，那段字只存在于组件内部；
 *   · P28 白板的笔迹抬笔后要等 500ms 才同步回 store，那个窗口里卸载**最后几笔直接丢**。
 *
 * 两处都是"交出去"的时机问题，所以共用一份缓冲（`createEditBuffer`）：
 * 定时器到点、blur、以及**卸载**都调同一个 `flush()`。
 */
describe("createEditBuffer：卸载/失焦都走同一个 flush", () => {
  it("⭐ 有未提交的改动 → flush 把它交出去（卸载时调的就是这一下）", () => {
    const wrote: string[] = [];
    const buffer = createEditBuffer((v) => wrote.push(v));
    buffer.set("打了一半的字");
    expect(buffer.dirty()).toBe(true);
    buffer.flush();
    expect(wrote, "没交出去 —— 卸载就丢了（P27/P28 的形状）").toEqual(["打了一半的字"]);
  });

  it("flush **幂等**：blur 与卸载连着调，只写一次（撤销栈里不多出空的一条）", () => {
    const wrote: string[] = [];
    const buffer = createEditBuffer((v) => wrote.push(v));
    buffer.set("内容");
    buffer.flush();
    buffer.flush();
    expect(wrote).toHaveLength(1);
  });

  it("没改过就不写（打开又关掉不该产生一次改动）", () => {
    const wrote: string[] = [];
    const buffer = createEditBuffer((v) => wrote.push(v));
    buffer.reset("原文");
    buffer.flush();
    expect(wrote).toEqual([]);
  });

  it("外部值变了（载入/撤销换快照）→ `reset` 之后以新的那份为基准", () => {
    const wrote: string[] = [];
    const buffer = createEditBuffer((v) => wrote.push(v));
    buffer.reset("旧");
    buffer.set("新");
    expect(buffer.pending()).toBe("新");
    buffer.reset("外部改成这个");
    expect(buffer.dirty(), "reset 之后没有未提交的改动").toBe(false);
    buffer.flush();
    expect(wrote).toEqual([]);
  });

  it("Esc 放弃草稿后再 flush 不会把它写回去（用户按了 Esc 就是不要这份）", () => {
    const wrote: string[] = [];
    const buffer = createEditBuffer((v) => wrote.push(v));
    buffer.reset("原文");
    buffer.set("改了一半");
    buffer.reset("原文"); // Esc 分支做的就是这个
    buffer.flush();
    expect(wrote).toEqual([]);
  });
});

describe("shouldCommitOnEnter：IME 组合态里不许提交", () => {
  const base = { key: "Enter", shiftKey: false };

  it("普通回车 → 提交", () => {
    expect(shouldCommitOnEnter(base)).toBe(true);
  });

  it("⭐ 组合态里的回车（输入法选词）**不许**提交", () => {
    expect(
      shouldCommitOnEnter({ ...base, isComposing: true }),
      "中文输入法里选词的回车被当成「确认」—— 一句话被切成好几段，还可能把拼音原文写进内容",
    ).toBe(false);
  });

  it("Shift+Enter 是换行，不提交", () => {
    expect(shouldCommitOnEnter({ key: "Enter", shiftKey: true })).toBe(false);
  });

  it("别的键不提交", () => {
    expect(shouldCommitOnEnter({ key: "a", shiftKey: false })).toBe(false);
  });
});
