import { describe, expect, it } from "vitest";

import type { ShellBridge } from "@shared/ipc";
import { exportDiagnosticsPackage } from "./feedbackExport";

/**
 * 「反馈」→ 诊断包导出（2026-10-17，V5 开工前清尾 §2.4 #7）。
 *
 * 组件那一层没有渲染环境，所以这里钉住客户端这半的四种状态：
 * 桥不在 / 成功（把人话连真实路径一起给）/ 主进程回失败 / 桥抛错。
 * 主进程那半（真正写盘 + 不含密钥）的回归在 `src/diagnosticsExport.test.ts`。
 */

function withShell(diagnostics?: Partial<ShellBridge["diagnostics"]>): void {
  (globalThis as unknown as { shell?: Partial<ShellBridge> }).shell = {
    diagnostics: diagnostics as ShellBridge["diagnostics"],
  };
}

function clearShell(): void {
  delete (globalThis as unknown as { shell?: unknown }).shell;
}

describe("反馈 → 诊断包导出（渲染侧）", () => {
  it("桥不在：如实说「需要应用」，不假装成功", async () => {
    clearShell();
    const got = await exportDiagnosticsPackage();
    expect(got.ok).toBe(false);
    expect(got.message).toContain("应用");
  });

  it("成功：话里带**真实路径**（用户要能拿它去贴给别人）", async () => {
    withShell({ export: async () => ({ ok: true, path: "C:\\tmp\\诊断包-1.json", bytes: 1234 }) });
    try {
      const got = await exportDiagnosticsPackage();
      expect(got.ok).toBe(true);
      expect(got.message).toContain("C:\\tmp\\诊断包-1.json");
    } finally {
      clearShell();
    }
  });

  it("主进程回失败：把它的原因原样带出来", async () => {
    withShell({ export: async () => ({ ok: false, error: "诊断包导出失败：磁盘满" }) });
    try {
      const got = await exportDiagnosticsPackage();
      expect(got.ok).toBe(false);
      expect(got.message).toContain("磁盘满");
    } finally {
      clearShell();
    }
  });

  it("桥抛错：也说成一句话（不冒泡成未捕获的 rejection）", async () => {
    withShell({
      export: async () => {
        throw new Error("通道断了");
      },
    });
    try {
      const got = await exportDiagnosticsPackage();
      expect(got.ok).toBe(false);
      expect(got.message).toContain("通道断了");
    } finally {
      clearShell();
    }
  });
});
