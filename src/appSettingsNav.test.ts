import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 两条**只有经过主进程才看得出来**的收窄（2026-10-16，审计交接项）。
 *
 * ## 为什么单开一个文件
 *
 * 这两处的共同点是：**渲染层的假桥测不出**——假桥直接把值透传，而真机要过主进程那一层。
 *   · `normalizeAppSettings` 不认识 `navCollapsed` 时，会把渲染层写进去的收起态**丢掉**：
 *     界面以为记住了、重启仍然忘（P187/P191 的接线因此**看上去**是好的）；
 *   · `sessionStore` 的旧日志迁移若把 `at` 一起剥掉，桌面那条**真实**迁移路径会把全部历史
 *     挤成"迁移那一刻"（P14/P31 的 store 已认记录自带的 `at`，但宿主先把 `at` 剥了）。
 *
 * 所以这里直接**对主进程那一层**断言（appSettings 用 `src/ipcStores.test.ts` 那套 mock 范式），
 * 迁移那条用源码级判据钉住写法。
 *
 * ## 变异实证
 *
 * · 把 `normalizeAppSettings` 里的 `navCollapsed` 去掉 → 前两条红；
 * · 把 `.map(({ seq: _seq, ...rest })` 改回 `.map(({ seq: _seq, at: _at, ...rest })` → 最后一条红。
 */

const env = vi.hoisted(() => ({ userData: "" }));

vi.mock("electron", () => ({
  app: { getPath: () => env.userData },
  ipcMain: { handle: () => undefined, removeHandler: () => undefined },
  powerSaveBlocker: { isStarted: () => false, start: () => 1, stop: () => undefined },
}));

const { normalizeAppSettings } = await import("../electron/ipc/appSettings");

beforeEach(() => {
  env.userData = path.join(process.env.TEMP ?? ".", "dsh-navatest");
});

describe("设置收窄不许丢掉左栏收起态（P187/P191）", () => {
  it("⭐ `navCollapsed: true` 要被认下来（丢了就是「界面以为记住了、重启仍然忘」）", () => {
    expect(normalizeAppSettings({ pinnedModel: "", navCollapsed: true }).navCollapsed).toBe(true);
  });

  it("落盘的东西不可信：只有真正的 `true` 才算收起", () => {
    for (const bad of [false, "true", 1, 0, null, undefined, {}]) {
      expect(normalizeAppSettings({ pinnedModel: "", navCollapsed: bad }).navCollapsed, String(bad)).toBe(false);
    }
  });
});

describe("旧会话日志迁移不许剥掉 `at`（P14/P31）", () => {
  it("⭐ 源码级：迁移那一步只许丢 `seq`", () => {
    const src = readFileSync(path.resolve(__dirname, "../electron/ipc/sessionStore.ts"), "utf8");
    /* 形状：`.map(({ seq: _seq, ...rest }) => rest)` —— 只丢 seq，留着自带时刻 */
    expect(src, "迁移把 `at` 一起剥掉了 —— 全部历史会被挤成「迁移那一刻」").toMatch(
      /\.map\(\(\{\s*seq:\s*_seq,\s*\.\.\.rest\s*\}\)\s*=>\s*rest\)/,
    );
    expect(src, "迁移里又出现了剥 `at` 的写法").not.toMatch(/seq:\s*_?\w*,\s*at:\s*_/);
  });
});
