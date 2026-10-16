import { readFileSync } from "node:fs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
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

  /**
   * 实现里**全部** handler 的通道名（按 `ipcMain.handle(` 切，多行写法也认）。
   *
   * ⚠️ 2026-10-16（审计 G21/G65）：这张"吃路径的 handler"清单原来写死 7 个，
   * 其中 `download` 那段还漏在外面（写法是多行）；真正吃路径的
   * `importPaths` / `importData` 也不在里面 —— 守卫漏的正是仍在的那几处。
   * 现在**从实现里反推**：凡是签名/体里出现 `filePath|paths|items|targetDir` 的 handler
   * 都算"吃路径的"，**必须**出现在下面这张表里，否则这条测试红。
   */
  /** 明确**不**算"渲染进程给路径"的通道（路径来自系统对话框，不是渲染层转手）。 */
  const DIALOG_CHANNELS = ["import"];

  function implChannels(): string[] {
    const out: string[] = [];
    for (const m of SRC.matchAll(/ipcMain\.handle\(\s*DRIVE_CHANNEL\.(\w+)/g)) out.push(m[1]!);
    return out;
  }

  const PATH_HANDLERS = [
    "remove",
    "reveal",
    "open",
    "duplicate",
    "download",
    "rename",
    "read",
    "importPaths",
    "importData",
  ] as const;

  for (const channel of PATH_HANDLERS) {
    it(`drive:${channel} 带路径校验`, () => {
      const block = handlerBlock(channel);
      /*
       * 允许三类校验（2026-10-16）：
       *   · 云盘归属判断（`insideOwnedDirs` / `sources().some` / `insideDirs`）；
       *   · **`lstat`/`realpath` 型**（审计 P04：渲染进程传入的路径必过 realpath/lstat，
       *     挡住符号链接穿越 —— `importPaths` 走的是这一类）。
       */
      const helpers = SRC.slice(SRC.indexOf("export async function importPaths("), SRC.indexOf("export function registerDriveIpc("));
      const guarded =
        block.includes("insideOwnedDirs(") ||
        block.includes("sources().some(") ||
        block.includes("insideDirs(") ||
        /validateImportSource\(|lstat\(|realpath\(/.test(block) ||
        /* 导入那两条路：校验在 helper 里（realpath/lstat），handler 只负责转手 */
        ((block.includes("importPaths(") || block.includes("importData(")) &&
          /validateImportSource\(|lstat\(|realpath\(/.test(helpers)) ||
        /* 写盘统一过 putIntoDrive：那里管名字净化、类型白名单与重名（两条导入路共用） */
        block.includes("putIntoDrive(");
      expect(guarded, `drive:${channel} 没有做目录校验 —— 这正是 A1 的缺陷形状`).toBe(true);
    });
  }

  it("⭐ 清单与实现对齐：实现里每个吃路径的 handler 都在表里（G65：等价判据不能悄悄长出来）", () => {
    const pathy = implChannels()
      .filter((c) => !DIALOG_CHANNELS.includes(c))
      .filter((c) => /filePath|paths\b|items\b|targetDir/.test(handlerBlock(c)));
    const missing = pathy.filter((c) => !(PATH_HANDLERS as readonly string[]).includes(c));
    expect(missing, "这些吃路径的 handler 没被这张守卫盯着 —— 新加的 handler 必须登记进来").toEqual([]);
  });

  it("⭐ A1 点名的两个 handler 走的是**同一个** `insideOwnedDirs`（不是各写一份）", () => {
    for (const channel of ["rename", "read"] as const) {
      expect(handlerBlock(channel)).toContain("insideOwnedDirs(");
    }
  });

  /**
   * ⚠️ **G21 的后半句**：`download` 一手交两个路径 —— 源（必须过白名单）与**目标目录**。
   *
   * 上面那条"带路径校验"只盯住了**源**（块里出现 `sources().some(` 就算过），
   * 于是 `targetDir` 那一半（渲染进程定目录 + 主进程写盘，**目录名不校验**）
   * 被判成了"已加锁" —— 而它其实是"任意目录写文件"这个原语交到了不可信的一侧。
   * 那段参数 2026-10-16 已整个删掉（唯一来源是系统「另存为」框），
   * 这条判据的作用是**别让它偷偷长回来**：
   *   · 块里不许出现 `targetDir`（或任何"目标目录"形状的东西）；
   *   · 参数表**只许两个**：`_event` 与 `filePath`。
   *
   * 判据落在**参数表**上而不是"有没有某个字符串"：多一个位置参数、或者换个名字
   * （`dest` / `outDir`）也一样会被数出来。
   */
  it("⭐ drive:download 的路径来源只能有一个：系统「另存为」框（G21 后半句）", () => {
    const block = handlerBlock("download");
    expect(block, "download 又收了渲染进程给的目标目录 —— 那是「任意目录写文件」这个原语").not.toMatch(
      /targetDir|destDir|outDir/,
    );
    const sig = block.match(/DRIVE_CHANNEL\.download,\s*async\s*\(([^)]*)\)/);
    expect(sig, "找不到 drive:download 的参数表").not.toBeNull();
    const params = (sig?.[1] ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    expect(params.length, `drive:download 的参数表多了东西：${params.join(" | ")}`).toBe(2);
    expect(params[0], "第一个参数应当是 event（这个 handler 不用它才写成 _event）").toMatch(/^_?event/);
    expect(params[1], "第二个参数只该是源文件路径；目标目录只能来自系统对话框").toMatch(/^filePath/);
  });
});

/**
 * 符号链接 / junction 不能穿墙（**审计 P04**）。
 *
 * ## 缺陷形状
 *
 * 原来只比 `path.resolve` 的**字面**结果：`C:\owned\link\secret.txt` 字面在
 * `C:\owned` 里就放行 —— 而 `link` 若是指向白名单外目录的 junction，
 * 真正落点在外面。四类落点（读/写/改/跑命令）共用这一处判断，所以这是个
 * 「一道闸被绕过，四个口子一起开」的形状。
 *
 * 这一条用**真实文件系统**造一个 junction 来钉它（不是读源码找 `realpath` 字样）——
 * 因为把 `path.relative(realPathFor(dir), realPathFor(raw))` 改回字面比较，
 * 这条会红；而只改注释/变量名不会。
 */
describe("insideDirs —— 符号链接 / junction 穿墙（P04）", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-drivepath-"));
  const owned = path.join(tmp, "owned");
  const outside = path.join(tmp, "outside");
  fs.mkdirSync(owned, { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(outside, "secret.txt"), "不该被读到");
  const link = path.join(owned, "link");
  let linked = false;
  try {
    /* Windows 上 "junction" 不需要管理员权限；POSIX 上这个 type 被忽略、当普通符号链接 */
    fs.symlinkSync(outside, link, "junction");
    linked = true;
  } catch {
    /*
     * 建不出链接（受限环境）时**跳过而不是放过** —— 跳过会如实显示在测试报告里，
     * 而"改判通过"会把这条守卫变成装饰（这正是 P04 当初没人发现的原因）。
     */
    linked = false;
  }
  afterAll(() => {
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch {
      /* Windows 上偶发 EBUSY，留个临时目录不算失败 */
    }
  });

  it.skipIf(!linked)("junction 指向白名单外：里面的文件被拒（这是 P04 的主判据）", () => {
    expect(insideDirs(path.join(link, "secret.txt"), [owned])).toBeNull();
  });

  it.skipIf(!linked)("junction 指向白名单外：链接自身也被拒", () => {
    expect(insideDirs(link, [owned])).toBeNull();
  });

  it.skipIf(!linked)("junction 指向白名单内：其下的文件仍放行（不能矫枉过正）", () => {
    const inner = path.join(owned, "inner");
    fs.mkdirSync(inner, { recursive: true });
    fs.writeFileSync(path.join(inner, "ok.txt"), "x");
    const innerLink = path.join(owned, "inner-link");
    fs.symlinkSync(inner, innerLink, "junction");
    expect(insideDirs(path.join(innerLink, "ok.txt"), [owned])).toBe(path.resolve(innerLink, "ok.txt"));
  });
});

