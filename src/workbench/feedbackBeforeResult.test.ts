import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { writeClipboard } from "./uiUtil";

/**
 * 守卫：**回执必须等结果**（2026-10-16，审计 P86）。
 *
 * 修前实测的三处：`void navigator.clipboard.writeText(text); flash("已复制")`（两处，复制与分享）、
 * `rewind(taskId, step.id); flash("已回到这一步")`（`rewindTask` 是 async，解析不到目标时
 * 直接 return，**什么都没做**却照样报喜）。共同形状：**反馈先于结果** ——
 * 用户看到"已复制"，粘出来却是旧内容；看到"已回到这一步"，界面其实一动没动。
 */
const ROOT = path.resolve(__dirname, "..", "..");

function read(rel: string): string {
  const text = readFileSync(path.join(ROOT, rel), "utf8");
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

describe("回执与结果（P86）", () => {
  it("writeClipboard：写成了才算成（抛异常 / 没权限 → false）", async () => {
    const original = navigator.clipboard;
    const writes: string[] = [];
    /* ① 正常写入 */
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: async (t: string) => writes.push(t) },
    });
    await expect(writeClipboard("甲")).resolves.toBe(true);
    expect(writes).toEqual(["甲"]);

    /* ② 写入失败（被占用 / 无权限）→ 老老实实 false */
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async () => {
          throw new Error("Document is not focused");
        },
      },
    });
    await expect(writeClipboard("乙"), "写失败还回 true 的话，界面就会说「已复制」").resolves.toBe(false);

    /* ③ 干脆没有剪贴板能力 */
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined });
    await expect(writeClipboard("丙")).resolves.toBe(false);

    Object.defineProperty(navigator, "clipboard", { configurable: true, value: original });
  });

  it("⭐ 源码守卫：复制 / 分享 / 回退三处都不许「先报喜后看结果」", () => {
    const src = read("src/workbench/MessageActions.tsx");
    expect(
      /void navigator\.clipboard\.writeText\(/.test(src),
      "又出现 `void navigator.clipboard.writeText(...)` 了 —— 写失败会说成「已复制」",
    ).toBe(false);
    expect(src, "复制要走 writeClipboard（它返回真的写成了没有）").toContain("writeClipboard(text)");
    expect(src, "分享那条也要").toContain("writeClipboard(markdown)");
    expect(src, "回退那条要按 rewindTask 的真实结果说话").toMatch(/rewind\(taskId, step\.id\)\.then\(\(ok\) => flash\(ok \?/);
  });

  it("⭐ 源码守卫：rewindTask 必须把「成没成」交出来（不能是 Promise<void>）", () => {
    const src = read("src/workbench/store.ts");
    expect(src, "rewindTask 的类型要能表达失败").toContain("rewindTask: (taskId: string, stepId: string) => Promise<boolean>");
    const at = src.indexOf("rewindTask: async (taskId, stepId) => {");
    expect(at, "找不到 rewindTask").toBeGreaterThan(-1);
    const segment = src.slice(at, src.indexOf("branchTask:", at));
    expect(segment, "解析不到目标时要 return false（而不是静默 return）").toContain("if (!target) return false;");
    expect(segment, "成功路径要 return true").toMatch(/return true;\n  \},/);
  });
});
