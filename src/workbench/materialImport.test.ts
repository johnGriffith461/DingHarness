import { describe, expect, it } from "vitest";
import { resolveImportedMaterials } from "./materialImport";

/**
 * 「从本机添加资料」的结果解析（2026-10-14）。
 *
 * 原生文件对话框没法自动化，所以这里钉住**它之外**的那段：
 * 导入结果 + 云盘清单 → 要附着哪些文件、哪些没进来、哪些认不回路径。
 */
describe("resolveImportedMaterials", () => {
  const list = [
    { name: "季度总结.md", path: "D:/data/drive/季度总结.md" },
    { name: "报告-2.md", path: "D:/data/drive/报告-2.md" },
  ];

  it("成功项从清单里认回路径", () => {
    const got = resolveImportedMaterials([{ name: "季度总结.md", ok: true }], list);
    expect(got.picked).toEqual([{ name: "季度总结.md", path: "D:/data/drive/季度总结.md" }]);
    expect(got.rejected).toEqual([]);
    expect(got.unmatched).toEqual([]);
  });

  it("重名被加了序号时，用 `savedAs` 那个真名去认（不是原文件名）", () => {
    const got = resolveImportedMaterials([{ name: "报告.md", ok: true, savedAs: "报告-2.md" }], list);
    expect(got.picked).toEqual([{ name: "报告-2.md", path: "D:/data/drive/报告-2.md" }]);
  });

  it("被拒的如实回报原因（不是静默丢掉）", () => {
    const got = resolveImportedMaterials([{ name: "x.exe", ok: false, reason: "formatUnsupported" }], list);
    expect(got.picked).toEqual([]);
    expect(got.rejected).toEqual([{ name: "x.exe", reason: "formatUnsupported" }]);
  });

  it("没给原因时兜底成 parseFail（界面上仍能说清「没进来」）", () => {
    expect(resolveImportedMaterials([{ name: "y.bin", ok: false }], list).rejected[0].reason).toBe("parseFail");
  });

  it("⭐ 清单里认不回路径的**单独一类** —— 不混进「被拒」，也不静默丢", () => {
    const got = resolveImportedMaterials([{ name: "不在清单里.md", ok: true }], list);
    expect(got.picked).toEqual([]);
    expect(got.rejected).toEqual([]);
    expect(got.unmatched).toEqual(["不在清单里.md"]);
  });

  it("一次导入里三种结果可以同时出现（各归各的）", () => {
    const got = resolveImportedMaterials(
      [
        { name: "季度总结.md", ok: true },
        { name: "x.exe", ok: false, reason: "formatUnsupported" },
        { name: "查无此件.md", ok: true },
      ],
      list,
    );
    expect(got.picked.map((p) => p.name)).toEqual(["季度总结.md"]);
    expect(got.rejected.map((r) => r.name)).toEqual(["x.exe"]);
    expect(got.unmatched).toEqual(["查无此件.md"]);
  });

  it("空输入不炸（用户取消了对话框）", () => {
    expect(resolveImportedMaterials([], list)).toEqual({ picked: [], rejected: [], unmatched: [] });
  });
});
