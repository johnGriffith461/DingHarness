import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * 守卫：**公开仓里不许留下「这台机器是谁」的痕迹**（2026-10-16，审计 D7）。
 *
 * ## 为什么这条要有
 *
 * 主人拍板的 D7 是「公开仓本机路径 → 脱敏/可复核写法」。审计当时点名的三类：
 * 用户目录带真实用户名、Playwright 的浏览器缓存目录、Git Bash 形态的盘符路径。
 *
 * 它们不影响构建，所以**没有任何东西会因为它们而报错**；它们只会安安静静地
 * 把「这份代码在谁的机器上、装在哪、逆向过什么」随仓库一起发出去。
 * 这正是「不报错、不崩、只是不该有」的那一类 —— 与 P94 同形，改法也一样：
 * 把它变成断言，而不是靠谁记得。
 *
 * ## 判据（只抓「本机身份」，不抓「Windows 路径」）
 *
 * 这条**刻意不禁止盘符路径**：`C:\work\proj`、`D:\我的项目`、
 * `C:\Program Files\nodejs\node.exe` 这类是**通用示意**，它们出现在注释与测试里
 * 是好事（说明白了自己在讲哪种路径）。要抓的是**具体到一台机器**的东西，见下面的
 * `PATTERNS`（每条都带为什么）。
 *
 * 其中「用户名」那一族**不许把某个具体账号写死**（写了这条守卫就会 match 到它自己），
 * 所以判据是「盘符 + Users + 一个**字母开头**的段」；占位写法
 * （`C:\Users\...`、`C:\Users\<name>`、`%USERNAME%`）不受影响 —— 那是示意，不是身份。
 *
 * ## 与 P94 那条守卫的分工
 *
 * `src/docRefs.test.ts` 管「引用了 `docs/**` 但没写明未入库」；这条管
 * 「引用里带着本机路径」。只改措辞而没写「未入库」仍会撞上 P94 那条，两条互补。
 *
 * ## 边界（如实记）
 *
 * 扫的是**源码目录 + 已入库的根文档**（与 `docRefs.test.ts` 同一套扫法）。
 * 仓库根的施工笔记（`HANDOFF-*.md` 这类）**不在扫描面内** —— 它们已经
 * `.gitignore` 掉并且 `git rm --cached` 了，本就不该出现在公开仓里（D7 一并修了），
 * 因此也不该由这条守卫来管。CI 与本地跑的是同一套 file list。
 */

const ROOT = path.resolve(__dirname, "..");
const SCAN_DIRS = ["src", "engine", "hosts", "electron", "shared", "scripts", "ADR"];
const EXT = [".ts", ".tsx", ".mjs", ".css", ".md", ".json"];
/** 根文档：只列**入库**的（未入库的施工笔记不在这儿，见上面「边界」）。 */
const ROOT_DOCS = ["README.md", "CHANGELOG.md", "SAFETY.md", "PLUGIN.md", "CONTRIBUTING.md", "CODE_OF_CONDUCT.md"];

/**
 * 用户目录那一族的判据（① 与 ②）。
 *
 * 抓到之后**还要看那一段是不是"名字"**：`C:\Users\x`（路径穿越用例里的负例）、
 * `C:\Users\<name>`、`%USERNAME%` 都是**示意**，不是身份。
 * 这条守卫的靶子是"把一个真实账户名发出去"，所以：
 *   · 段长 < 3 → 当占位（`x` / `me` / `u`）；剥掉 `.`/`-`/`_` 后为空也算占位（`...`）；
 *   · 段在下面的白名单里 → 当占位。
 *
 * 白名单分两拨，**这两拨的区别就是判据本身**：
 *   · 通用占位词（`user` / `test` / `foo` / `example` …）—— 明显不是名字；
 *   · **惯用的虚构人名**（`alice` / `bob` …）—— RFC 与各家文档里的示例名，
 *     它们与非虚构真名的区别在于"没有指向任何具体的人"。
 * ⚠️ **刻意不含** `administrator` / `admin` —— 那正是"真实账户名长什么样"，
 * 放进去等于把靶心挖掉（本机账户名就是这个形状，审计点名的也是它）。
 * 边界如实记：真实用户名若恰好叫 `alice`/`user`，这条守卫会漏掉它（可接受：那名字不指向谁）。
 */
const PLACEHOLDER_USERS = new Set([
  "user",
  "users",
  "username",
  "usr",
  "name",
  "test",
  "foo",
  "bar",
  "baz",
  "someone",
  "somebody",
  "someoneelse",
  "placeholder",
  "example",
  "sample",
  "demo",
  "home",
  // 惯用虚构人名（文档/测试里的示例账户）
  "alice",
  "bob",
  "carol",
  "dave",
]);

function looksLikeRealUser(seg: string): boolean {
  // 先剥掉 `.`/`-`/`_`：`C:\Users\...` 这种占位抓出来是 `...`，剥完是空串，自然不算名字。
  const s = seg.toLowerCase().replace(/[^a-z0-9]/g, "");
  return s.length >= 3 && !PLACEHOLDER_USERS.has(s);
}

/** ① 盘符形态：`C:\Users\<段>` / `C:/Users/<段>`（源码里是转义过的双反斜杠，故用 `+`）。 */
const USER_WIN = new RegExp("[A-Za-z]:[\\\\/]+Users[\\\\/]+([A-Za-z0-9._-]+)");
/** ② Git Bash / MSYS 形态：`/c/Users/<段>`。 */
const USER_POSIX = new RegExp("/[cC]/Users/([A-Za-z0-9._-]+)");

/** 其余两条判据（不需要看「段是不是名字」）。 */
/**
 * ⚠️ 拼出来而不是写字面量：写了的话这条守卫会 match 到**它自己**（同 P94 那条的注意事项）。
 *
 * ⚠️⚠️ **2026-10-16 自己踩到的坑，留在这里当例子**：第一版写的是
 * `["ms", "play", "wright"].join("-")` —— 三段拼出来多了一个连字符，
 * 于是这条判据**一直是哑的**：真正那个缓存目录名永远匹配不上，而守卫照样"绿"。
 * 哑守卫比没守卫更糟（它让人以为查过了）。
 * 现在拼法改成不会拼错的两段，并且下面那条**判据自检**用例会当场把它揪出来。
 * （连这条注释都不敢把那串写出来 —— 写了就会被自己逮住。）
 */
const PLAYWRIGHT_CACHE_RE = new RegExp(["ms", "playwright"].join("-"));

/** 指向仓外工作区的盘符绝对路径（那些目录既不在仓里、又是本机磁盘位置）。 */
const OUT_OF_REPO_RE = new RegExp("[A-Za-z]:[\\\\/][^\\s`\"'()<>|]*(doubaoworkclone|reverse-out|workbuddy)", "i");

const PATTERNS: Array<{ what: string; re: RegExp }> = [
  { what: "Playwright 浏览器缓存目录", re: PLAYWRIGHT_CACHE_RE },
  { what: "指向仓外工作区的盘符绝对路径", re: OUT_OF_REPO_RE },
];

function entriesOf(d: string): string[] {
  try {
    return readdirSync(d);
  } catch {
    return [];
  }
}

function files(): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const name of entriesOf(d)) {
      const full = path.join(d, name);
      let isDir = false;
      try {
        isDir = statSync(full).isDirectory();
      } catch {
        continue;
      }
      if (isDir) {
        if (name === "node_modules" || name === ".git") continue;
        walk(full);
      } else if (EXT.some((e) => name.endsWith(e))) {
        out.push(full);
      }
    }
  };
  for (const dir of SCAN_DIRS) walk(path.join(ROOT, dir));
  for (const d of ROOT_DOCS) {
    const full = path.join(ROOT, d);
    try {
      if (statSync(full).isFile()) out.push(full);
    } catch {
      /* 没有就没有 */
    }
  }
  return out;
}

describe("公开仓里的本机路径痕迹（D7）", () => {
  it("扫描面本身要够大 —— 不许因为走不动目录而「什么都没扫到地通过」", () => {
    // 恒真的守卫等于没守卫（本仓反复踩过：G53 / G88 都是这一类）。
    expect(files().length).toBeGreaterThan(80);
  });

  /**
   * ⭐ **判据自检**（2026-10-16 补）。
   *
   * 起因是这条守卫自己踩的坑：浏览器缓存目录那一条第一版把三段拼错了一个连字符，
   * **判据一直是哑的、守卫却照样绿**。所以除了"扫到的代码里没有本机路径"，
   * 还得单独证明"每条判据真能命中它要抓的形状"—— 否则判据写错时没人知道。
   *
   * 样本一律**用字符串拼**（`${BS}` 之类），避免这份测试文件自己被自己的判据命中。
   */
  it("判据自检：每条模式都得真命中它要抓的形状，且不误伤占位写法", () => {
    const BS = "\\"; // 一个反斜杠，写出来会与下面的样本撞车，故拼
    const winReal = `C:${BS}Users${BS}Administrator${BS}x.md`;
    const winPlaceholder = `C:${BS}Users${BS}...${BS}x.md`;
    const posixReal = `/${"c"}/Users/${["admin", "istrator"].join("")}/x.md`;
    const playwrightPath = ["/home/u/.cache", ["ms", "playwright"].join("-"), "chromium"].join("/");
    const outOfRepo = `D:${BS}${["Doubao", "WorkClone"].join("")}${BS}src`;

    // ① 用户目录：真名命中、占位不命中
    expect(USER_WIN.exec(winReal)?.[1]).toBe("Administrator");
    expect(USER_WIN.exec(winPlaceholder)?.[1]).toBe("...");
    expect(looksLikeRealUser("Administrator"), "真名必须算身份").toBe(true);
    expect(looksLikeRealUser("..."), "占位不是身份").toBe(false);
    expect(looksLikeRealUser("x")).toBe(false);
    expect(looksLikeRealUser("user"), "这些词本身不指向谁").toBe(false);
    expect(USER_POSIX.exec(posixReal)?.[1]).toBe("administrator");

    // ② 浏览器缓存目录（就是上面拼错过的那个）
    expect(PLAYWRIGHT_CACHE_RE.source).toBe(["ms", "playwright"].join("-"));
    expect(PLAYWRIGHT_CACHE_RE.test(playwrightPath), "这条判据曾经因为拼错而完全哑掉").toBe(true);

    // ③ 仓外工作区的盘符路径
    expect(OUT_OF_REPO_RE.test(outOfRepo), "仓外工作区路径要抓得住").toBe(true);
    // 但**通用示意**不许被抓：这是 Windows 路径文档与测试里最常见的东西
    expect(OUT_OF_REPO_RE.test(`C:${BS}work${BS}proj`)).toBe(false);
  });

  it("⭐ 源码与已入库文档里不许出现本机身份路径（用户名 / 浏览器缓存目录 / 仓外工作区）", () => {
    const offenders: string[] = [];
    for (const file of files()) {
      const rel = path.relative(ROOT, file).split(path.sep).join("/");
      const lines = readFileSync(file, "utf8").split("\n");
      for (const [i, line] of lines.entries()) {
        const at = `${rel}:${i + 1}`;
        const snippet = line.trim().slice(0, 100);
        // ①②：用户目录 —— 只有那一段"像真名"时才算
        for (const [what, re] of [
          ["用户目录带真实用户名", USER_WIN],
          ["Git Bash 形态的用户目录", USER_POSIX],
        ] as const) {
          const m = re.exec(line);
          if (m && looksLikeRealUser(m[1])) offenders.push(`${at} → [${what}] ${snippet}`);
        }
        // ③④：与"名字"无关的两条
        for (const { what, re } of PATTERNS) {
          if (re.test(line)) offenders.push(`${at} → [${what}] ${snippet}`);
          // 非全局正则不会记住 lastIndex；显式重置是为了将来有人给这些正则加 `g` 时不必再想一遍。
          re.lastIndex = 0;
        }
      }
    }
    expect(
      offenders,
      [
        "公开仓里出现了「这台机器是谁」的痕迹 —— 它们不会让任何检查变红，只会随仓库一起发出去：",
        ...offenders,
        "",
        "改法（D7）：换成不依赖本机的写法。例：",
        "  · 带账户名的用户目录 → 「仓外工作区里的一份《x.md》（未入库、无法复核）」；",
        "  · 旧工程的工作目录 → 「接入前那版工程的工作目录」；",
        "  · 浏览器缓存目录 → 「浏览器包目录」，或在代码里用 app.getPath() / env 现取。",
        "",
        "（占位写法不受影响：`C:\\Users\\x`、`C:\\Users\\<name>`、`%USERNAME%` 都算示意。）",
      ].join("\n"),
    ).toEqual([]);
  });
});
