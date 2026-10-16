import { describe, expect, it } from "vitest";
import type { CanvasDocument } from "@shared/ipc";
import { createCanvasSaver, shouldApplyLoadedDoc, validateRevision, serializeCanvas } from "./canvasSaver";
import type { CanvasNode } from "./types";
import { makeMarkdownNode } from "./types";

/**
 * 画布落盘三件套（2026-10-16 审计 P16 / P17 / P29）。
 *
 * ## 为什么这三条要一起测
 *
 * 它们全在"什么时候把哪一份交出去、写完记哪个数"这一层，而且都是**静默**的：
 *   · P16 空画布被示例图盖回来 **且** 此后每次保存都被拒（状态栏永久「保存失败」）；
 *   · P17 正在写盘时的第二次请求被丢弃 —— 关窗前那一下丢了最后一次编辑；
 *   · P29 每份落盘都自称"已确认"，于是主进程那套崩溃回退**永不可达**。
 *
 * 原来它们和 React 的 hook 缠在一起，只能读源码判；抽成 `canvasSaver.ts` 之后
 * 这里用**假桥**把三种时间顺序都真跑一遍。
 */

const node = (id: string, x = 0, y = 0): CanvasNode => makeMarkdownNode(id, { x, y }, "内容", undefined, id);

/** 假的主进程画布侧：记下每一次写盘，并可以卡住（模拟"写一半"）。 */
function fakeApi() {
  const saved: CanvasDocument[] = [];
  const acked: number[] = [];
  let gate: Promise<void> | null = null;
  return {
    saved,
    acked,
    /** 让下一次 save 挂住，直到 `release()`。 */
    hold: () => {
      gate = new Promise<void>((resolve) => {
        gateRelease = resolve;
      });
    },
    api: {
      save: async (doc: CanvasDocument): Promise<{ ok: boolean; error?: string }> => {
        if (gate) await gate;
        saved.push(doc);
        return { ok: true };
      },
      ack: async (revision: number): Promise<unknown> => {
        acked.push(revision);
        return undefined;
      },
    },
  };
}
let gateRelease: () => void = () => undefined;

function saverWith(
  api: { save: (doc: CanvasDocument) => Promise<{ ok: boolean; error?: string }>; ack: (r: number) => Promise<unknown> },
  revision: () => number,
) {
  const states: string[] = [];
  const errors: string[] = [];
  const saver = createCanvasSaver({
    api: () => api,
    read: () => ({ nodes: [node("n1")], edges: [], viewport: { x: 0, y: 0, zoom: 1 }, markers: [], revision: revision() }),
    onState: (s) => states.push(s),
    onError: (e) => errors.push(e),
  });
  return { saver, states, errors };
}

describe("P29：落盘里的 `confirmedRevision` 是**上一次确认过的**那个数", () => {
  it("⭐ 第一次写盘不能自称「已确认」—— 否则主进程的崩溃回退分支永久不可达", async () => {
    const fake = fakeApi();
    let revision = 7;
    const { saver } = saverWith(fake.api as never, () => revision);

    await saver.save();

    expect(fake.saved).toHaveLength(1);
    expect(
      fake.saved[0]!.confirmedRevision,
      "写出去的文档自称已确认到当前修订 —— 主进程那句 `confirmedRevision >= revision → 不回退` 就恒成立，回退机制成了摆设",
    ).toBe(0);
    expect(fake.saved[0]!.revision).toBe(7);
    /* ack 之后才把它记成已确认 */
    expect(saver.acknowledged()).toBe(7);

    revision = 8;
    await saver.save();
    expect(fake.saved[1]!.confirmedRevision, "第二份该自称「确认到 7」").toBe(7);
  });

  it("save 失败（主进程拒了）时不推进确认号，下一次仍说「确认到 0」", async () => {
    const calls: CanvasDocument[] = [];
    let fail = true;
    const saver = createCanvasSaver({
      api: () => ({
        save: async (doc) => {
          calls.push(doc);
          return fail ? { ok: false, error: "磁盘满" } : { ok: true };
        },
        ack: async () => undefined,
      }),
      read: () => ({ nodes: [node("n1")], edges: [], viewport: { x: 0, y: 0, zoom: 1 }, markers: [], revision: 3 }),
    });
    await saver.save();
    expect(saver.acknowledged()).toBe(0);
    expect(saver.persisted(), "写失败了就不能把基线往前推（否则下一次会被判倒退）").toBe(0);
    fail = false;
    await saver.save();
    expect(calls[1]!.confirmedRevision).toBe(0);
  });
});

describe("P17：并发的第二次保存不许被静默丢掉", () => {
  it("⭐ 第一次还在写、这时又来一次 → 两次都真写出去，第二次带的是**新**修订号", async () => {
    const fake = fakeApi();
    let revision = 1;
    const { saver } = saverWith(fake.api as never, () => revision);

    fake.hold(); // 第一次卡在写盘里
    revision = 1;
    const first = saver.save();
    revision = 2; // 写盘过程中用户又改了一笔（关窗前那一下正是这个形状）
    const second = saver.save();

    gateRelease(); // 放行第一次
    await Promise.all([first, second]);
    await saver.idle();

    expect(fake.saved.length, "第二次被静默丢掉了 —— 最后一次编辑没落盘").toBe(2);
    expect(fake.saved[1]!.revision, "补写的那一份必须是**最新**修订").toBe(2);
  });

  it("写盘期间的多次请求**合并成一次补写**（不是排成一串 N 次）", async () => {
    const fake = fakeApi();
    let revision = 5;
    const { saver } = saverWith(fake.api as never, () => revision);
    fake.hold();
    const first = saver.save();
    revision = 6;
    const second = saver.save();
    revision = 7;
    const third = saver.save();
    gateRelease();
    await Promise.all([first, second, third]);
    await saver.idle();
    expect(fake.saved.length, "合并：初写一次 + 补写一次（补的那次带的是最新快照）").toBe(2);
    expect(fake.saved[1]!.revision).toBe(7);
  });
});

describe("P16：载入的文档到底要不要覆盖当前画布", () => {
  it("⭐ 空画布 + 磁盘修订号 > 0（用户自己清空过）→ **必须**覆盖", () => {
    expect(
      shouldApplyLoadedDoc({ revision: 5, nodes: [] }),
      "清空过的画布被判成「全新安装」→ 示例图盖回来，而且基线错位后每次保存都被拒",
    ).toBe(true);
  });

  it("全新安装（主进程回的是空文档、修订号 0）→ 不覆盖（留着示例画布）", () => {
    expect(shouldApplyLoadedDoc({ revision: 0, nodes: [] })).toBe(false);
  });

  it("有节点就照载（哪怕修订号是 0 —— 手改过的文件）", () => {
    expect(shouldApplyLoadedDoc({ revision: 0, nodes: [node("n1")] })).toBe(true);
  });

  it("修订号坏了（NaN）时按「不覆盖」处理，不试图用坏基线去写盘", () => {
    expect(shouldApplyLoadedDoc({ revision: Number.NaN, nodes: [] })).toBe(false);
  });
});

describe("反例：把 P16 的判据换回「有节点才载入」，这一条会红", () => {
  it("清空过的画布与全新安装**必须被区分开**", () => {
    const cleared = shouldApplyLoadedDoc({ revision: 9, nodes: [] });
    const fresh = shouldApplyLoadedDoc({ revision: 0, nodes: [] });
    expect(cleared, "两者判成了同一种 —— 正是 P16 的形状").not.toBe(fresh);
  });
});

describe("既有口径没被改坏", () => {
  it("validateRevision 仍然拒绝非整数/负数/倒退", () => {
    expect(validateRevision(1.5, 0).ok).toBe(false);
    expect(validateRevision(-1, 0).ok).toBe(false);
    expect(validateRevision(2, 5).ok).toBe(false);
    expect(validateRevision(5, 5).ok).toBe(true);
  });

  it("serializeCanvas 仍然丢掉函数/不可序列化的东西", () => {
    const dirty = { ...node("n1"), data: { text: "x", boom: () => undefined } } as unknown as CanvasNode;
    const doc = serializeCanvas({
      nodes: [dirty],
      edges: [],
      viewport: { x: 0, y: 0, zoom: 1 },
      revision: 1,
      confirmedRevision: 0,
    });
    const round = JSON.parse(JSON.stringify(doc));
    expect(round.nodes[0].data.boom).toBeUndefined();
    expect(doc.confirmedRevision).toBe(0);
  });
});
