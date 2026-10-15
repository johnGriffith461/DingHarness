import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 桌面的插件安装那条口子的**守卫**（Phase 8.4）。
 *
 * ⚠️ 这是唯一一处**渲染进程能把字符串递给主进程去执行**的地方
 * （`plugins.install(spec)`），所以它值得单独一组断言。
 * 与"工作区授权"同一个理由：安装的目录由系统对话框给；而从 npm 装时那个字符串
 * **必须**只是一个包名 —— 否则 `npm pack ../某处` 就成了一条
 * "让主进程执行任意本地目录"的路。
 */

const env = vi.hoisted(() => ({ userData: "" }));

vi.mock("electron", () => ({
  app: { getPath: () => env.userData },
  dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
  ipcMain: { handle: () => undefined },
}));

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "dh-plugin-ipc-"));
  env.userData = dir;
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/* 模块级 await import：与 `ipcStores.test.ts` 同一套手法（先 mock electron，再加载主进程模块） */
const { isSafeNpmSpec } = await import("../electron/ipc/pluginHost");

describe("isSafeNpmSpec", () => {

  it("正常的包名与版本过得去", () => {
    for (const ok of ["my-plugin", "ding-plugin-hello", "@scope/pkg", "pkg@1.2.3", "@scope/pkg@^1.0.0", "p.v_1"]) {
      expect(isSafeNpmSpec(ok), `应当允许：${ok}`).toBe(true);
    }
  });

  it("⭐ 路径与协议前缀一律拒（包名不是路径）", () => {
    for (const bad of [
      "../somewhere",
      "..\\somewhere",
      "./local-dir",
      "/abs/path",
      "C:\\Windows\\x",
      "file:./x",
      "http://example.com/x.tgz",
      "a/b",
      "@scope/../evil",
    ]) {
      expect(isSafeNpmSpec(bad), `应当拒掉：${bad}`).toBe(false);
    }
  });

  it("空串与超长也拒（前者没意义，后者不成包名）", () => {
    expect(isSafeNpmSpec("")).toBe(false);
    expect(isSafeNpmSpec("a".repeat(200))).toBe(false);
  });

  it("带空格的注入尝试拒掉", () => {
    for (const bad of ["pkg --registry http://evil", "pkg; rm -rf /", "pkg && echo x"]) {
      expect(isSafeNpmSpec(bad), `应当拒掉：${bad}`).toBe(false);
    }
  });
});
