import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * **G17 诊断包：预览接线的守卫**（源码级 —— 这一层没有渲染环境）。
 *
 * 三条最容易"写了没接"的：
 * ① 主进程注册了 preview、preload 桥了出去（少一处界面就调不到）；
 * ② 「反馈」命令走的是预览，而不是直接写盘（G17 的承诺就是"先看清"）；
 * ③ 预览用的是**同一份**组装（`buildDiagnosticsBundle`），不是另拼一份。
 */

const ROOT = path.resolve(__dirname, "..");
const read = (rel: string): string => readFileSync(path.join(ROOT, rel), "utf8");

describe("G17：预览接线", () => {
  it("主进程注册 preview 通道，preload 把 preview 桥出去", () => {
    expect(read("electron/ipc/diagnostics.ts")).toContain("DIAG_CHANNEL.preview");
    expect(read("electron/preload.ts")).toContain("DIAG_CHANNEL.preview");
  });

  it("预览与导出是同一份组装（不是另拼）", () => {
    const src = read("electron/ipc/diagnostics.ts");
    const previewFn = /export function previewDiagnostics[\s\S]*?\n\}/.exec(src)?.[0] ?? "";
    expect(previewFn.length).toBeGreaterThan(50);
    expect(previewFn, "预览没走 buildDiagnosticsBundle —— 用户看到的可能不是要导出的").toContain("buildDiagnosticsBundle");
    expect(previewFn, "预览居然写盘了（它应该只返回文本）").not.toContain("writeFileSync");
  });

  it("「反馈」命令先开预览，不直接导出", () => {
    const feedback = read("src/workbench/feedbackExport.ts");
    const runFn = /export function runFeedbackCommand[\s\S]*?\n\}/.exec(feedback)?.[0] ?? "";
    expect(runFn.length).toBeGreaterThan(50);
    expect(runFn).toContain("dsh-open-diagnostics");
    expect(runFn, "反馈又直接导出了 —— 用户没有过目机会").not.toContain("exportDiagnosticsPackage()");
  });

  it("预览浮层被挂到工作台，且命令面板里也有入口", () => {
    expect(read("src/workbench/Workbench.tsx")).toContain("<DiagnosticsDialog />");
    expect(read("src/workbench/CommandPalette.tsx")).toContain("dsh-open-diagnostics");
  });

  it("最近事件不读正文（`body` 与 `payload.text` 都不该被取）", () => {
    const src = read("electron/ipc/diagnostics.ts");
    const recentFn = /export function recentActivity[\s\S]*?\n\}/.exec(src)?.[0] ?? "";
    expect(recentFn.length).toBeGreaterThan(100);
    expect(recentFn, "最近事件的查询里带上了 body 列").not.toMatch(/SELECT[\s\S]*\bbody\b/);
    expect(recentFn, "代码里读了 payload.text —— 正文不该进诊断包").not.toContain("payload.text");
  });
});
