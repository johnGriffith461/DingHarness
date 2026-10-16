import { mkdtempSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { removeAll } from "./testFs";

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
  removeAll(dir);
});

/* 模块级 await import：与 `ipcStores.test.ts` 同一套手法（先 mock electron，再加载主进程模块） */
const { isSafeNpmSpec } = await import("../electron/ipc/pluginHost");

describe("接线：安装口子**真的**过这个谓词（G33）", () => {
  it("pluginHost 的安装 handler 调 `isSafeNpmSpec`（守卫不能只测纯谓词）", () => {
    /*
     * ⚠️ 2026-10-16（审计 G33）：这份文件的标题写着守"渲染进程能把字符串递给主进程执行"这件事，
     * 而**全文只测了纯谓词**（`isSafeNpmSpec`）—— 谓词对、但安装 handler 忘了调它，
     * 一组测试照样全绿。这里补**接线**那一半：安装 handler 的源码里必须出现这个谓词调用。
     * （纯谓词那一半在上面那几个用例里；两层都在，才算"口子被守住了"。）
     */
    const host = readFileSync(path.join(__dirname, "../electron/ipc/pluginHost.ts"), "utf8");
    /* ⚠️ 要从 `ipcMain.handle(` 处切：`PLUGIN_CHANNEL.install` 这个串在通道表里也出现（第一版切错了段）*/
    const from = host.indexOf("ipcMain.handle(PLUGIN_CHANNEL.install");
    expect(from, "找不到安装 handler").toBeGreaterThan(-1);
    const install = host.slice(from, host.indexOf("ipcMain.handle(PLUGIN_CHANNEL.uninstall"));
    expect(install, "安装 handler 里没有调 isSafeNpmSpec —— 谓词再严也拦不住").toContain("isSafeNpmSpec(");
    expect(install, "安装 handler 没有拒绝分支（谓词调了但结果没用）").toMatch(/if\s*\(!isSafeNpmSpec/);
  });
});

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
