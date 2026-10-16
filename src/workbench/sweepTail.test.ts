import { describe, expect, it } from "vitest";
import { clockOf } from "./duration";
import { parseAskReply } from "./agent";
import { centerSections } from "./taskCenter";
import { extractFilePaths, fileContextBlock, truncateByCodePoint } from "./fileContext";
import type { WorkTask } from "./task";

/**
 * 第 5 单 sweep 尾巴里"纯逻辑那一族"的判据（2026-10-16）：
 *   · P272 时长文案出现 `0:60` 这种不存在的时间；
 *   · P269 `</ask>` 之后的正文被丢掉；
 *   · P266「最近访问」按 `createdAt` 排（显示的其实是「最近创建」）；
 *   · P268 含空格的 Windows 路径被截成假路径；
 *   · P255（兄弟处）按 UTF-16 码元截断，切出孤立代理对。
 */

describe("P272：时长不许出现 0:60 / 1:60", () => {
  it("⭐ 59.6 秒 → 1:00（不是 0:60）", () => {
    expect(clockOf(59.6), "秒那一半单独 round 会出现 60 —— 一个不存在的时间").toBe("1:00");
  });

  it("⭐ 119.6 秒 → 2:00（不是 1:60）", () => {
    expect(clockOf(119.6)).toBe("2:00");
  });

  it("普通值照常", () => {
    expect(clockOf(0)).toBe("0:00");
    expect(clockOf(5)).toBe("0:05");
    expect(clockOf(125)).toBe("2:05");
  });

  it("坏值给 0:00（不显示 NaN）", () => {
    expect(clockOf(Number.NaN)).toBe("0:00");
    expect(clockOf(-3)).toBe("0:00");
  });

  it("任何一个非负秒数的秒位都在 00–59（扫一遍）", () => {
    for (let ms = 0; ms <= 200_000; ms += 37) {
      const text = clockOf(ms / 1000);
      const rest = Number(text.split(":")[1]);
      expect(rest, `${ms}ms → ${text}`).toBeLessThan(60);
    }
  });
});

describe("P269：`</ask>` 之后的正文不能丢", () => {
  const raw = ["好的，我先确认两件事。", "<ask>", "要不要带上截图？", "- 带", "- 不带", "</ask>", "（不回也行，我按第一个选项开工）"].join("\n");

  it("⭐ 结束标记之后的补充要进正文（不回复则该说的那句不能消失）", () => {
    const { text, questions } = parseAskReply(raw);
    expect(text, "`</ask>` 之后的正文被整段丢掉了（P269）").toContain("不回也行，我按第一个选项开工");
    expect(text, "标记本身当然要剥掉").not.toContain("</ask>");
    expect(text, "提问块的内容也不该混进正文").not.toContain("要不要带上截图");
    expect(questions).toHaveLength(1);
  });

  it("标记之前有一句话时，两段都在", () => {
    const { text } = parseAskReply(raw);
    expect(text).toContain("我先确认两件事");
    expect(text).toContain("不回也行");
  });

  it("没有提问块时行为不变（全是正文）", () => {
    expect(parseAskReply("直接干活").text).toBe("直接干活");
  });
});

describe("P266：「最近访问」按访问时刻排", () => {
  const task = (id: string, createdAt: number, openedAt?: number, steps: Array<{ at: number }> = []): WorkTask =>
    ({
      id,
      title: id,
      brief: "",
      createdAt,
      stage: "done",
      startedAt: createdAt,
      finishedAt: createdAt,
      steps: steps.map((s, i) => ({ id: `s${i}`, role: "user" as const, text: "x", at: s.at })),
      questions: [],
      questionIndex: 0,
      activity: "",
      artifacts: [],
      ...(openedAt === undefined ? {} : { openedAt }),
    }) as unknown as WorkTask;

  it("⭐ 昨天建的、今天打开过 → 排在今天新建的前面", () => {
    const yesterday = task("老对话", 1000, 9000);
    const today = task("今天新建", 8000);
    const { recent } = centerSections([yesterday, today]);
    expect(
      recent.map((t) => t.id),
      "按 createdAt 排 = 这一栏显示的其实是「最近创建」（P266）",
    ).toEqual(["老对话", "今天新建"]);
  });

  it("没有访问时刻时回落到「最后一步的时刻」（老数据也有说话时间）", () => {
    const chatted = task("昨天建的但今天说过话", 1000, undefined, [{ at: 7000 }]);
    const fresh = task("今天新建", 8000);
    expect(centerSections([chatted, fresh]).recent.map((t) => t.id)).toEqual(["今天新建", "chatted".replace("chatted", "昨天建的但今天说过话")].map((x) => (x === "chatted" ? x : x)) as never);
  });

  it("什么都没有时回落到 createdAt（不编访问时刻）", () => {
    const a = task("a", 1000);
    const b = task("b", 2000);
    expect(centerSections([a, b]).recent.map((t) => t.id)).toEqual(["b", "a"]);
  });
});

describe("P268：含空格的 Windows 路径要整条认出来", () => {
  it("⭐ 目录名带空格（`OneDrive - 公司`）不被截断", () => {
    const got = extractFilePaths("看下 C:\\Users\\me\\OneDrive - 公司\\季度总结.md 讲了什么");
    expect(got, "截成 `C:\\Users\\me\\OneDrive` 之后主进程必然读不到，界面还会说「它不在云盘里」").toEqual([
      "C:\\Users\\me\\OneDrive - 公司\\季度总结.md",
    ]);
  });

  it("`Program Files` 那种也认", () => {
    expect(extractFilePaths("打开 D:\\Program Files\\app\\config.json")).toEqual([["D:", "Program Files", "app", "config.json"].join("\\")]);
  });

  it("⭐ 别把后面的散文吃进路径", () => {
    expect(extractFilePaths("看下 D:\\a\\b.md 讲了什么")).toEqual(["D:\\a\\b.md"]);
  });

  it("⭐ 两条路径不许被粘成一条（第二个片断里出现新盘符就断开）", () => {
    expect(extractFilePaths("对比 D:\\a\\b.md 和 E:\\c\\d.md")).toEqual(["D:\\a\\b.md", "E:\\c\\d.md"]);
  });

  it("末尾中文标点照旧削掉", () => {
    expect(extractFilePaths("看下 D:\\a\\b.md，总结一下")).toEqual(["D:\\a\\b.md"]);
  });

  it("普通相对路径与 `/usr/...` 仍然不认（宁可漏认，也不把正文误当路径）", () => {
    expect(extractFilePaths("看下 rel/readme.md 和 /usr/local/x")).toEqual([]);
  });
});

describe("P255（兄弟处）：按码点截断，不许切出孤立代理对", () => {
  it("⭐ 截点落在代理对内部时，结果串仍是合法 UTF-16", () => {
    const text = "中文😀中文😀"; // 每个 emoji 是两个码元
    for (const n of [1, 2, 3, 4, 5, 6, 7, 8]) {
      const cut = truncateByCodePoint(text, n);
      expect(cut.isWellFormed(), `按 ${n} 截出来的串不是合法的 UTF-16（孤立代理）`).toBe(true);
      expect(cut.length).toBeLessThanOrEqual(text.length);
    }
  });

  it("截断点正好在一个代理对中间那个位置（这是原来的坏法）", () => {
    /* "a😀" = ['a','😀']；按码元切 2 会得到 "a" + 高代理 */
    const whole = "a😀b";
    expect(whole.slice(0, 2).isWellFormed(), "夹具本身要立得住：按码元切会切出孤立代理").toBe(false);
    expect(truncateByCodePoint(whole, 2).isWellFormed()).toBe(true);
    expect(truncateByCodePoint(whole, 2)).toBe("a😀");
  });

  it("不超上限时原样返回", () => {
    expect(truncateByCodePoint("abc", 10)).toBe("abc");
  });

  it("⭐ 文件正文那一块真的按码点截（并如实报总字数）", () => {
    const body = "字".repeat(5) + "😀".repeat(5);
    const block = fileContextBlock([{ path: "D:\\a.md", text: body }], 6);
    expect(block).toContain("已截断");
    /* 手写切片会把 emoji 切半个 —— 现在整块串必须合法 */
    expect(block.isWellFormed(), "送进请求体的正文里有孤立代理（编码时会变成 U+FFFD）").toBe(true);
  });
});
