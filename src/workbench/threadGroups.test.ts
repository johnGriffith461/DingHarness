import { describe, expect, it } from "vitest";
import {
  THREAD_SUMMARY_LIMIT,
  bucketOf,
  groupThreads,
  lastActiveAt,
  summaryOf,
} from "./threadGroups";
import type { WorkTask } from "./task";

/** 造一个任务（只填用得到的字段）。 */
const task = (over: Partial<WorkTask> & { id: string }): WorkTask => ({
  title: over.id,
  brief: "",
  createdAt: 0,
  stage: "done",
  startedAt: null,
  finishedAt: null,
  steps: [],
  questions: [],
  questionIndex: 0,
  activity: "",
  artifacts: [],
  ...over,
});

/** 本地时间的某天 10 点。 */
const at = (y: number, m: number, d: number, h = 10) => new Date(y, m - 1, d, h).getTime();
const NOW = at(2026, 10, 12, 20);

describe("lastActiveAt", () => {
  it("取创建时间与全部步骤时间的最大值", () => {
    expect(lastActiveAt(task({ id: "a", createdAt: 100, steps: [{ id: "s", role: "user", text: "x", at: 500 }] }))).toBe(500);
    expect(lastActiveAt(task({ id: "b", createdAt: 900, steps: [{ id: "s", role: "user", text: "x", at: 500 }] }))).toBe(900);
    expect(lastActiveAt(task({ id: "c", createdAt: 0 }))).toBe(0);
  });
});

describe("bucketOf：按自然日，不是按 24 小时差", () => {
  it("今天 / 昨天", () => {
    expect(bucketOf(at(2026, 10, 12, 1), NOW)).toBe("今天");
    expect(bucketOf(at(2026, 10, 12, 19), NOW)).toBe("今天");
    expect(bucketOf(at(2026, 10, 11, 23), NOW)).toBe("昨天");
  });

  it("⚠️ 关键边界：23 小时前是「昨天」而不是「今天」，25 小时前是「昨天」而不是「近 7 天」", () => {
    // 若按"差几个 24 小时"算，下面第一条会被算成今天 —— 那与截图里按天的分组不符
    expect(bucketOf(NOW - 21 * 60 * 60 * 1000, NOW)).toBe("昨天");
    expect(bucketOf(NOW - 25 * 60 * 60 * 1000, NOW)).toBe("昨天");
  });

  it("近 7 天 / 近 30 天 / 近一年 / 更早", () => {
    expect(bucketOf(at(2026, 10, 6), NOW)).toBe("近 7 天");
    expect(bucketOf(at(2026, 10, 5), NOW)).toBe("近 7 天"); // 恰好 7 天，还在桶里
    expect(bucketOf(at(2026, 10, 4), NOW)).toBe("近 30 天"); // 8 天 → 掉出 7 天档
    expect(bucketOf(at(2026, 9, 20), NOW)).toBe("近 30 天");
    expect(bucketOf(at(2026, 8, 1), NOW)).toBe("近一年");
    expect(bucketOf(at(2025, 8, 1), NOW)).toBe("更早");
  });
});

describe("groupThreads", () => {
  it("按档位顺序输出，空桶不出现", () => {
    const groups = groupThreads(
      [task({ id: "今", createdAt: at(2026, 10, 12, 9) }), task({ id: "老", createdAt: at(2025, 1, 1) })],
      NOW,
    );
    expect(groups.map((g) => g.label)).toEqual(["今天", "更早"]);
  });

  it("桶内按最近活动时间从新到旧", () => {
    const groups = groupThreads(
      [
        task({ id: "早", createdAt: at(2026, 10, 12, 8) }),
        task({ id: "晚", createdAt: at(2026, 10, 12, 18) }),
        task({ id: "中", createdAt: at(2026, 10, 12, 12) }),
      ],
      NOW,
    );
    expect(groups[0]?.tasks.map((t) => t.id)).toEqual(["晚", "中", "早"]);
  });

  it("活动时间算的是最后一步，不是创建时间（聊过的会往上浮）", () => {
    const groups = groupThreads(
      [
        task({ id: "老任务但刚聊过", createdAt: at(2026, 10, 1), steps: [{ id: "s", role: "user", text: "hi", at: at(2026, 10, 12, 18) }] }),
        task({ id: "新建", createdAt: at(2026, 10, 12, 8) }),
      ],
      NOW,
    );
    expect(groups[0]?.label).toBe("今天");
    expect(groups[0]?.tasks.map((t) => t.id)).toEqual(["老任务但刚聊过", "新建"]);
  });

  it("没有任务时返回空数组", () => {
    expect(groupThreads([], NOW)).toEqual([]);
  });
});

describe("summaryOf", () => {
  it("取最后一条有内容的步骤", () => {
    expect(
      summaryOf(
        task({
          id: "a",
          steps: [
            { id: "1", role: "user", text: "第一句", at: 1 },
            { id: "2", role: "assistant", text: "回了一句", at: 2 },
          ],
        }),
      ),
    ).toBe("回了一句");
  });

  it("把换行与连续空白收成一行（它要在行内单行显示）", () => {
    expect(summaryOf(task({ id: "a", steps: [{ id: "1", role: "assistant", text: "第一行\n\n第二行   还有空格", at: 1 }] }))).toBe(
      "第一行 第二行 还有空格",
    );
  });

  it("超长截断并加省略号", () => {
    const long = "很".repeat(200);
    const got = summaryOf(task({ id: "a", steps: [{ id: "1", role: "user", text: long, at: 1 }] }));
    expect(got.length).toBe(THREAD_SUMMARY_LIMIT + 1);
    expect(got.endsWith("…")).toBe(true);
  });

  it("空会话显示「打开对话」（本体截图里「新画布」那几行就是这四个字，不是我编的）", () => {
    expect(summaryOf(task({ id: "a" }))).toBe("打开对话");
    expect(summaryOf(task({ id: "b", steps: [{ id: "1", role: "user", text: "   ", at: 1 }] }))).toBe("打开对话");
  });

  it("有 brief 但没步骤时用 brief 兜底", () => {
    expect(summaryOf(task({ id: "a", brief: "帮我写周报" }))).toBe("帮我写周报");
  });
});
