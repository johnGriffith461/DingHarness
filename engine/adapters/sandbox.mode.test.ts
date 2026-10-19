import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  SANDBOX_UNAVAILABLE,
  SandboxUnavailableError,
  assertSandboxAvailable,
  parseSandboxMode,
  writeEffectAllowed,
  type SandboxInfo,
} from "./sandbox";

/**
 * F2：沙箱模式与 fail-closed。
 * 判据：`workspace-write` 在 runner 不可用时**明确失败**；文件效果按模式判。
 */

const info = (patch: Partial<SandboxInfo> = {}): SandboxInfo => ({
  found: true,
  bounded: true,
  binary: "x",
  platform: "win32",
  memoryMb: 2048,
  processes: 32,
  note: "",
  ...patch,
});

describe("模式词表", () => {
  it("只认三个词，坏值回落到 danger-full-access", () => {
    expect(parseSandboxMode("read-only")).toBe("read-only");
    expect(parseSandboxMode("workspace-write")).toBe("workspace-write");
    expect(parseSandboxMode("danger-full-access")).toBe("danger-full-access");
    expect(parseSandboxMode("whatever")).toBe("danger-full-access");
  });
});

describe("assertSandboxAvailable", () => {
  it("⭐ workspace-write 但没找到 runner → SANDBOX_UNAVAILABLE", () => {
    expect(() => assertSandboxAvailable("workspace-write", info({ found: false }))).toThrow(SandboxUnavailableError);
    try {
      assertSandboxAvailable("workspace-write", info({ found: false }));
    } catch (error) {
      expect((error as SandboxUnavailableError).code).toBe(SANDBOX_UNAVAILABLE);
    }
  });

  it("⭐ workspace-write 但本平台没有隔离实现 → 也拒绝", () => {
    expect(() => assertSandboxAvailable("workspace-write", info({ bounded: false }))).toThrow(SandboxUnavailableError);
  });

  it("read-only / danger-full-access 不依赖 runner", () => {
    expect(() => assertSandboxAvailable("read-only", info({ found: false }))).not.toThrow();
    expect(() => assertSandboxAvailable("danger-full-access", info({ found: false }))).not.toThrow();
  });

  it("workspace-write + 有隔离 → 通过", () => {
    expect(() => assertSandboxAvailable("workspace-write", info())).not.toThrow();
  });
});

describe("writeEffectAllowed", () => {
  const root = path.resolve("C:/work");

  it("read-only 拒绝一切写", () => {
    expect(writeEffectAllowed("read-only", root, path.join(root, "a.ts"))).toMatchObject({ ok: false });
  });

  it("workspace-write 只允许工作区内", () => {
    expect(writeEffectAllowed("workspace-write", root, path.join(root, "src/a.ts"))).toEqual({ ok: true });
    expect(writeEffectAllowed("workspace-write", root, path.resolve("C:/outside.ts"))).toMatchObject({ ok: false });
  });

  it("danger-full-access 不拦", () => {
    expect(writeEffectAllowed("danger-full-access", root, path.resolve("C:/outside.ts"))).toEqual({ ok: true });
  });
});
