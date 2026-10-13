import { describe, expect, it } from "vitest";
import { MAX_PINNED } from "@shared/library";
import {
  CENTER_LABELS,
  RECENT_LIMIT,
  canPin,
  centerSections,
  isOngoing,
  needsStopConfirm,
  orderByPinned,
  pinLimitToast,
} from "./taskCenter";
import type { WorkTask } from "./task";

/**
 * 任务中心（§154）。
 *
 * ⚠️ 文案断言对着 `docs/evidence-taskcenter.txt`（本体前端包里的原文）——
 * 它们同时是"证据仍然对齐"的守卫。
 */
const task = (id: string, stage: WorkTask["stage"], createdAt = 0): WorkTask => ({
  id,
  title: `任务${id}`,
  brief: `任务${id}`,
  createdAt,
  stage,
  startedAt: createdAt,
  finishedAt: null,
  steps: [],
  questions: [],
  questionIndex: 0,
  activity: "",
  artifacts: [],
});

describe("文案与本体对齐（逐字取自 appEntryManage_* 证据）", () => {
  it("标题与三块的分区名", () => {
    expect(CENTER_LABELS.title).toBe("任务中心");
    expect(CENTER_LABELS.ongoing).toBe("进行中的任务");
    expect(CENTER_LABELS.recent).toBe("最近访问");
    expect(CENTER_LABELS.explore).toBe("发现更多服务");
  });

  it("空态那句把三块一起说了", () => {
    expect(CENTER_LABELS.empty).toBe("置顶、最近访问的内容和进行中的任务将展示在这里");
  });

  it("置顶 / 取消置顶 / 移除确认的文案", () => {
    expect(CENTER_LABELS.pin).toBe("置顶");
    expect(CENTER_LABELS.unpin).toBe("取消置顶");
    expect(CENTER_LABELS.stopDeleteDesc).toBe("移除同时将停止当前任务");
    expect(CENTER_LABELS.stopDelete).toBe("移除并停止");
  });

  it("满了时的提示口径与库模块共用一个上限", () => {
    expect(pinLimitToast()).toBe(`最多可置顶 ${MAX_PINNED} 个服务`);
    expect(pinLimitToast(3)).toBe("最多可置顶 3 个服务");
  });
});

describe("canPin（为什么要在界面这一侧先判）", () => {
  it("没满就能置顶", () => {
    expect(canPin([], "t1").ok).toBe(true);
  });

  it("⭐ 满了给**能说出口的原因** —— 库里的 togglePinned 是静默返回原对象", () => {
    const full = Array.from({ length: MAX_PINNED }, (_, i) => `p${i}`);
    const got = canPin(full, "t1");
    expect(got.ok).toBe(false);
    expect(got.reason).toBe(pinLimitToast());
  });

  it("已经置顶的不再重复置顶", () => {
    expect(canPin(["t1"], "t1").reason).toBe("已经置顶了");
  });

  it("满了但**这一个已经在里面**时，报的是「已置顶」而不是「满了」（原因要准）", () => {
    const full = Array.from({ length: MAX_PINNED }, (_, i) => `p${i}`);
    expect(canPin(full, "p0").reason).toBe("已经置顶了");
  });
});

describe("centerSections", () => {
  it("进行中 = running / awaiting", () => {
    expect(isOngoing({ stage: "running" })).toBe(true);
    expect(isOngoing({ stage: "awaiting" })).toBe(true);
    expect(isOngoing({ stage: "done" })).toBe(false);
  });

  it("分到两块里，且**两块不重叠**", () => {
    const got = centerSections([task("a", "running"), task("b", "done"), task("c", "awaiting")]);
    expect(got.ongoing.map((t) => t.id).sort()).toEqual(["a", "c"]);
    expect(got.recent.map((t) => t.id)).toEqual(["b"]);
  });

  it("两块各自**新的在前**", () => {
    const got = centerSections([task("old", "done", 1), task("new", "done", 9), task("mid", "running", 5)]);
    expect(got.recent.map((t) => t.id)).toEqual(["new", "old"]);
    expect(got.ongoing.map((t) => t.id)).toEqual(["mid"]);
  });

  it("超过上限的进「查看更多」，而不是丢掉", () => {
    const many = Array.from({ length: RECENT_LIMIT + 3 }, (_, i) => task(`t${i}`, "done", i));
    const got = centerSections(many);
    expect(got.recent).toHaveLength(RECENT_LIMIT);
    expect(got.more).toBe(3);
  });

  it("刚好等于上限时没有「查看更多」", () => {
    const exact = Array.from({ length: RECENT_LIMIT }, (_, i) => task(`t${i}`, "done", i));
    expect(centerSections(exact).more).toBe(0);
  });

  it("空列表给两个空数组（空态由界面负责说那句）", () => {
    const got = centerSections([]);
    expect(got.ongoing).toEqual([]);
    expect(got.recent).toEqual([]);
    expect(got.more).toBe(0);
  });
});

describe("orderByPinned", () => {
  it("置顶的排最前，顺序按置顶顺序", () => {
    const list = [task("a", "done"), task("b", "done"), task("c", "done")];
    expect(orderByPinned(list, ["c", "a"]).map((t) => t.id)).toEqual(["c", "a", "b"]);
  });

  it("没有置顶时保持原顺序", () => {
    const list = [task("a", "done", 2), task("b", "done", 1)];
    expect(orderByPinned(list, []).map((t) => t.id)).toEqual(["a", "b"]);
  });

  it("不改原数组（免得把 store 里的顺序搅乱）", () => {
    const list = [task("a", "done"), task("b", "done")];
    orderByPinned(list, ["b"]);
    expect(list.map((t) => t.id)).toEqual(["a", "b"]);
  });

  it("置顶了个不存在的 id 也不炸", () => {
    expect(orderByPinned([task("a", "done")], ["zzz"]).map((t) => t.id)).toEqual(["a"]);
  });
});

describe("needsStopConfirm", () => {
  it("⭐ 在跑的对话要先问（移除会把它停掉）", () => {
    expect(needsStopConfirm({ stage: "running" })).toBe(true);
    expect(needsStopConfirm({ stage: "awaiting" })).toBe(true);
  });

  it("已经结束的直接移除，不必打扰用户", () => {
    expect(needsStopConfirm({ stage: "done" })).toBe(false);
  });
});
