import { describe, expect, it } from "vitest";
import { READ_MAX_BYTES, RENAME_LABELS, isTextKind, planRename } from "@shared/driveFiles";

/**
 * 云盘的改名与读取（§158）。
 *
 * 断言对着 `docs/evidence-drive.txt`：
 * `drive_menuOption_rename` / `drive_rename_header` / `drive_rename_btn_rename` / `_cancel`
 * / `drive_menuOption_AIReading`。
 */
describe("文案与本体对齐", () => {
  it("改名那几个词", () => {
    expect(RENAME_LABELS.title).toBe("重命名");
    expect(RENAME_LABELS.ok).toBe("确认");
    expect(RENAME_LABELS.cancel).toBe("取消");
  });

  it("空名字用证据里那句", () => {
    expect(RENAME_LABELS.empty).toBe("名称不能为空");
  });
});

describe("planRename", () => {
  const existing = ["a.md", "b-产物.md", "c-图片.png"];

  it("正常改名通过，并去掉首尾空白", () => {
    const got = planRename("a.md", "  季度复盘.md  ", existing);
    expect(got).toEqual({ ok: true, name: "季度复盘.md" });
  });

  it("⭐ 空名字挡住，说的是证据里那句", () => {
    const got = planRename("a.md", "   ", existing);
    expect(got.ok).toBe(false);
    if (!got.ok) expect(got.reason).toBe("名称不能为空");
  });

  it("⭐ 路径分隔符挡住 —— 否则能改到云盘目录外面去", () => {
    for (const bad of ["../逃逸.md", "a/b.md", "a\\b.md"]) {
      const got = planRename("a.md", bad, existing);
      expect(got.ok).toBe(false);
      if (!got.ok) expect(got.reason).toContain("路径分隔符");
    }
  });

  it("⭐ 重名挡住 —— **不覆盖**（覆盖是不可逆的）", () => {
    const got = planRename("a.md", "b-产物.md", existing);
    expect(got.ok).toBe(false);
    if (!got.ok) expect(got.reason).toContain("已经有同名文件");
  });

  it("⭐ 重名判断不区分大小写（Windows 上 A.md 与 a.md 是同一个文件）", () => {
    expect(planRename("a.md", "C-图片.PNG", existing).ok).toBe(false);
  });

  it("改成自己原来的名字：**通过**，不算错（别弹一个「失败」）", () => {
    expect(planRename("a.md", "a.md", existing)).toEqual({ ok: true, name: "a.md" });
  });

  it("只是大小写不同的自己：也算重名（Windows 会拒），先说清", () => {
    expect(planRename("a.md", "A.md", existing).ok).toBe(false);
  });

  it("过长挡住", () => {
    expect(planRename("a.md", `${"长".repeat(81)}.md`, existing).ok).toBe(false);
  });

  it("目录里没有别的文件时随便改", () => {
    expect(planRename("a.md", "新名.md", ["a.md"]).ok).toBe(true);
  });
});

describe("isTextKind（能不能读成文本）", () => {
  it("文档 / 代码 / 画布 / 表格能读", () => {
    for (const k of ["doc", "code", "canvas", "sheet"]) expect(isTextKind(k)).toBe(true);
  });

  it("⭐ 图片不硬读（会读出一堆乱码塞进阅读面板）", () => {
    expect(isTextKind("image")).toBe(false);
    expect(isTextKind("other")).toBe(false);
  });

  it("文本上限是个明确的数（几兆的东西会把界面卡住）", () => {
    expect(READ_MAX_BYTES).toBe(200 * 1024);
  });
});
