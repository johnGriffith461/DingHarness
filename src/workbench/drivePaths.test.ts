import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { insideDirs } from "@engine/runtime/tools/drivePaths";

/**
 * 云盘路径的归属判断（**A1**）。
 *
 * ## 为什么这条测试有存在的必要
 *
 * A1 修的是一个**漏接线**的缺陷：`drive:remove` / `duplicate` / `reveal` / `open`
 * 都走了 `insideOwnedDirs`，唯独 `drive:rename` 与 `drive:read` 没走 ——
 * 于是渲染进程（在 `electron/main.ts` 的 `sandbox: false` 之下）传任意路径，
 * 就能改任意文件名、读任意 ≤200KB 的文本。
 *
 * 这类缺陷**修一次不等于不再犯**：代码里少写一句校验不需要任何理由，
 * 而且当时它一条测试都不会红（主进程在本项目没有测试基础设施）。所以这里钉两件事：
 *
 * 1. **判断本身**（`electron/ipc/drivePaths.ts`）—— 真断言，跑在 `pnpm test` 里；
 * 2. **接线**—— `driveStore.ts` 里每一个吃 `filePath` 的 handler 都必须带校验。
 *    只测第 1 件挡不住第 2 件的复发，只测第 2 件又只是在读源码，两件都要。
 *
 * 被测文件放在 `electron/` 下而不是 `shared/`：判断要用 `node:path`，而 `shared/`
 * 是被浏览器侧（Vite 构建）一起用的，塞不进 Node 内置模块（这是分层，不是洁癖）。
 */

/** 平台无关地造一个绝对路径（Windows 上是 `D:\...`，Linux 上是 `/...`）。 */
const ROOT = path.resolve("verify-fixture");

/** 白名单：两个"自己的目录"。 */
const OWNED = [path.join(ROOT, "drive"), path.join(ROOT, "artifacts")];

describe("insideDirs —— 放行", () => {
  it("目录里的文件通过，并返回**解析后的绝对路径**", () => {
    const file = path.join(OWNED[0], "季度复盘.md");
    expect(insideDirs(file, OWNED)).toBe(path.resolve(file));
  });

  it("二级目录里的文件也通过（产物目录是平的，但判断本身不该只认一层）", () => {
    const file = path.join(OWNED[1], "sub", "a.png");
    expect(insideDirs(file, OWNED)).toBe(path.resolve(file));
  });

  it("多个白名单目录里**任一个**命中即可", () => {
    const file = path.join(OWNED[1], "a.png");
    expect(insideDirs(file, OWNED)).toBe(path.resolve(file));
  });

  it("带 `..` 但**回得来**的路径通过（`drive/sub/../a.md` 仍在云盘里）", () => {
    const weird = path.join(OWNED[0], "sub", "..", "a.md");
    expect(insideDirs(weird, OWNED)).toBe(path.join(OWNED[0], "a.md"));
  });

  it("⚠️ 口径声明：**目录自身**放行 —— 与原实现逐字一致（A1 不改这道校验的语义）", () => {
    // 「整个云盘目录自己」该怎么办，由各 handler 自己挡：
    //   · rename 要求源必须是普通文件（`stat.isFile()`）
    //   · read   本来就要求 `stat.isFile()`
    // 这里把当前口径**写成断言**，将来谁改了它，这一条会红。
    expect(insideDirs(OWNED[0], OWNED)).toBe(path.resolve(OWNED[0]));
  });
});

describe("insideDirs —— 拦截", () => {
  it("兄弟目录里的文件被拒（这是 A1 要挡的主要一类）", () => {
    expect(insideDirs(path.join(ROOT, "elsewhere", "secret.txt"), OWNED)).toBeNull();
  });

  it("`..` 穿越出去被拒", () => {
    expect(insideDirs(path.join(OWNED[0], "..", "secret.txt"), OWNED)).toBeNull();
  });

  it("盘根 / 系统目录那种绝对路径被拒", () => {
    // 平台无关地造一个"白名单之外、且在某个根下"的路径
    const outside = path.join(path.parse(ROOT).root, "outside-secret.txt");
    expect(insideDirs(outside, OWNED)).toBeNull();
  });

  it("空串 / `undefined` / `null` 都被拒（不是「当成当前目录」放行）", () => {
    expect(insideDirs("", OWNED)).toBeNull();
    expect(insideDirs(undefined as unknown as string, OWNED)).toBeNull();
    expect(insideDirs(null as unknown as string, OWNED)).toBeNull();
  });

  it("白名单为空时一律拒绝", () => {
    expect(insideDirs(path.join(OWNED[0], "a.md"), [])).toBeNull();
  });

  it.skipIf(process.platform !== "win32")("Windows：**大小写不敏感**（`C:\\A\\B` 仍是同一个目录）", () => {
    // `path.win32.relative` 自己做小写化比较，所以这里应当判为"在里"而不是"在外"
    const upper = OWNED[0].toUpperCase();
    expect(insideDirs(path.join(upper, "a.md"), OWNED)).toBe(path.join(upper, "a.md"));
  });
});

/**
 * 接线守卫（第二件事）。
 *
 * 只断言"有校验"，**不**规定用哪一种写法 —— 因为 `drive:download` 一直用的是
 * `sources().some(...)`（它要顺带排除"目录自身"，与 `insideOwnedDirs` 的语义不同），
 * 强求统一会把它改坏。这里要挡的是**完全没校验**那一种。
 */
describe("driveStore 的接线：每个吃 filePath 的 handler 都必须带校验", () => {
  const SRC = readFileSync(path.resolve(__dirname, "../../electron/ipc/driveStore.ts"), "utf8");

  /** 取某个 handler 的源码片段（从它自己的 `ipcMain.handle` 到下一个为止）。 */
  function handlerBlock(channel: string): string {
    const at = SRC.indexOf(`DRIVE_CHANNEL.${channel}`);
    expect(at, `driveStore.ts 里找不到 ${channel} 的 handler`).toBeGreaterThan(-1);
    // 往回找到本 handler 的开头，保证取到的是自己的那段
    const head = SRC.lastIndexOf("ipcMain.handle", at);
    const next = SRC.indexOf("ipcMain.handle", at + 1);
    return SRC.slice(head, next === -1 ? undefined : next);
  }

  const PATH_HANDLERS = ["remove", "reveal", "open", "duplicate", "download", "rename", "read"] as const;

  for (const channel of PATH_HANDLERS) {
    it(`drive:${channel} 带路径校验`, () => {
      const block = handlerBlock(channel);
      const guarded = block.includes("insideOwnedDirs(") || block.includes("sources().some(");
      expect(guarded, `drive:${channel} 没有做目录校验 —— 这正是 A1 的缺陷形状`).toBe(true);
    });
  }

  it("⭐ A1 点名的两个 handler 走的是**同一个** `insideOwnedDirs`（不是各写一份）", () => {
    for (const channel of ["rename", "read"] as const) {
      expect(handlerBlock(channel)).toContain("insideOwnedDirs(");
    }
  });
});
