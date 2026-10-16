import { describe, expect, it } from "vitest";
import {
  ORIGIN_LABEL,
  countByKind,
  DRIVE_KIND_META,
  DriveEntry,
  formatBytes,
  formatDriveTime,
  kindOf,
  selectEntries,
  sortByName,
  sortByRecent,
} from "@shared/drive";

/** 造一条文件。 */
function entry(name: string, patch: Partial<DriveEntry> = {}): DriveEntry {
  return {
    name,
    path: `C:/x/${name}`,
    bytes: 1024,
    createdAt: 1000,
    modifiedAt: 1000,
    kind: kindOf(name),
    origin: "drive",
    ...patch,
  };
}

describe("kindOf —— 扩展名到类目", () => {
  it("文档类", () => {
    for (const n of ["周报.md", "说明.txt", "总结.docx", "合同.pdf", "a.markdown", "b.rtf"]) {
      expect(kindOf(n), n).toBe("doc");
    }
  });

  it("表格类", () => {
    for (const n of ["数据.xlsx", "旧表.xls", "导出.csv"]) expect(kindOf(n), n).toBe("sheet");
  });

  it("演示类", () => {
    for (const n of ["路演.pptx", "老稿.ppt"]) expect(kindOf(n), n).toBe("slides");
  });

  it("图片类", () => {
    for (const n of ["图.png", "照.jpg", "a.jpeg", "b.webp", "c.gif", "d.svg", "e.bmp"]) {
      expect(kindOf(n), n).toBe("image");
    }
  });

  it("json 归画布（不是代码）—— 否则画布产物在云盘里看不见", () => {
    expect(kindOf("canvas.json")).toBe("canvas");
  });

  it("代码类", () => {
    for (const n of ["index.html", "app.ts", "main.py", "s.sh", "c.yml"]) {
      expect(kindOf(n), n).toBe("code");
    }
  });

  it("认不出来的归其他，不硬猜", () => {
    expect(kindOf("神秘文件.xyz")).toBe("other");
    expect(kindOf("没有扩展名")).toBe("other");
    expect(kindOf("")).toBe("other");
    expect(kindOf(".gitignore")).toBe("other");
  });

  it("大小写不影响", () => {
    expect(kindOf("报表.XLSX")).toBe("sheet");
    expect(kindOf("图.PNG")).toBe("image");
  });
});

describe("DRIVE_KIND_META", () => {
  it("每个类目都有显示名与色调", () => {
    for (const [kind, meta] of Object.entries(DRIVE_KIND_META)) {
      expect(meta.label, kind).toBeTruthy();
      expect(meta.tone, kind).toMatch(/^is-/);
    }
  });
});

describe("sortByRecent —— 「最近」的口径", () => {
  it("按修改时间倒序", () => {
    const list = [entry("a", { modifiedAt: 100 }), entry("b", { modifiedAt: 300 }), entry("c", { modifiedAt: 200 })];
    expect(sortByRecent(list).map((e) => e.name)).toEqual(["b", "c", "a"]);
  });

  it("**时间相同时按名字兜底**，保证顺序稳定（否则每次渲染都在跳）", () => {
    const list = [entry("c", { modifiedAt: 100 }), entry("a", { modifiedAt: 100 }), entry("b", { modifiedAt: 100 })];
    expect(sortByRecent(list).map((e) => e.name)).toEqual(["a", "b", "c"]);
    // 再排一次结果一样
    expect(sortByRecent(sortByRecent(list)).map((e) => e.name)).toEqual(["a", "b", "c"]);
  });

  it("不改原数组", () => {
    const list = [entry("a", { modifiedAt: 1 }), entry("b", { modifiedAt: 2 })];
    sortByRecent(list);
    expect(list.map((e) => e.name)).toEqual(["a", "b"]);
  });
});

describe("sortByName", () => {
  it("按名字排（中文按拼音序）", () => {
    /*
     * ⚠️ 2026-10-16（审计 G53.a）：原来的输入是 `[丙, 甲, 乙]`，期望也是 `[丙, 甲, 乙]` ——
     * **输入序就等于期望序**，一个不排序的实现照样过（这就是 `sortByName` 的唯一测试）。
     * 现在给一个乱序输入，并按拼音序给出期望（丙 bing < 甲 jia < 乙 yi）。
     */
    const list = [entry("乙"), entry("丙"), entry("甲")];
    expect(sortByName(list).map((e) => e.name)).toEqual(["丙", "甲", "乙"]);
  });
});

describe("selectEntries —— 三个 tab", () => {
  const list = [
    entry("a.md", { modifiedAt: 300 }),
    entry("b.xlsx", { modifiedAt: 100 }),
    entry("c.png", { modifiedAt: 200 }),
  ];

  it("最近：按修改时间倒序", () => {
    expect(selectEntries(list, "recent", new Set()).map((e) => e.name)).toEqual(["a.md", "c.png", "b.xlsx"]);
  });

  it("我的：按名字排", () => {
    expect(selectEntries(list, "mine", new Set()).map((e) => e.name)).toEqual(["a.md", "b.xlsx", "c.png"]);
  });

  it("收藏：只留收藏过的", () => {
    const starred = new Set(["c.png"]);
    expect(selectEntries(list, "starred", starred).map((e) => e.name)).toEqual(["c.png"]);
  });

  it("收藏为空时返回空列表（不是全量）", () => {
    expect(selectEntries(list, "starred", new Set())).toEqual([]);
  });
});

describe("formatBytes", () => {
  it("四档单位", () => {
    expect(formatBytes(890)).toBe("890 B");
    expect(formatBytes(1024)).toBe("1.0 KB");
    expect(formatBytes(12698)).toBe("12.4 KB");
    expect(formatBytes(1024 * 1024 * 1.2)).toBe("1.2 MB");
    expect(formatBytes(1024 * 1024 * 1024 * 2)).toBe("2.00 GB");
  });

  it("0 与非法值不产出怪文案", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(-5)).toBe("0 B");
    expect(formatBytes(Number.NaN)).toBe("0 B");
  });
});

describe("formatDriveTime", () => {
  const now = new Date("2026-10-11T20:00:00").getTime();

  it("同年只报月日与时分", () => {
    const at = new Date("2026-07-02T15:04:00").getTime();
    expect(formatDriveTime(at, now)).toBe("7月2日 15:04");
  });

  it("跨年带上年份", () => {
    const at = new Date("2025-07-02T15:04:00").getTime();
    expect(formatDriveTime(at, now)).toBe("2025年7月2日");
  });

  it("分钟补零", () => {
    const at = new Date("2026-07-02T15:04:00").getTime();
    expect(formatDriveTime(at, now)).toContain("15:04");
  });

  it("非法时间返回空串", () => {
    expect(formatDriveTime(Number.NaN, now)).toBe("");
  });
});

describe("countByKind", () => {
  it("统计各类目数量", () => {
    const list = [entry("a.md"), entry("b.md"), entry("c.xlsx"), entry("d.png")];
    expect(countByKind(list)).toEqual({ doc: 2, sheet: 1, image: 1 });
  });

  it("空列表给空对象", () => {
    expect(countByKind([])).toEqual({});
  });
});


describe("来源标签（§166）", () => {
  it("⭐ 四个来源都有说法（加一个来源时，界面不必再回去改一处 if）", () => {
    expect(ORIGIN_LABEL.artifact).toBe("产物");
    expect(ORIGIN_LABEL.export).toBe("导出");
    expect(ORIGIN_LABEL.asset).toBe("素材");
  });

  it("云盘本体（用户自己导进来的）不挂来源标签 —— 它是默认情形，标了反而多余", () => {
    expect(ORIGIN_LABEL.drive).toBe("");
  });

  it("⭐ 每个来源的值都是「要么有标签、要么是空串」，不许出现 undefined（界面会渲染成 「undefined」）", () => {
    for (const [k, v] of Object.entries(ORIGIN_LABEL)) {
      expect(typeof v, `来源 ${k} 的标签`).toBe("string");
    }
  });
});
