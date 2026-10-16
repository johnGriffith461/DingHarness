import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * 守卫：**CSS 的注释与花括号必须配平**。
 *
 * ## 为什么要有这一条
 *
 * 2026-10-16：一个补丁往 `src/styles/ding-harness-tokens.css` 里追加内容时，
 * 顺手削掉了 12 行 —— 正好是「本地适配 C」那段注释的结尾**和**浅色档
 * `--tint-blue: var(--accent-tint)` 那一块。后果是：
 *
 * 1. 注释没闭合 → 从那一行起**后面整段规则都成了注释**（含夜间档的同一族映射）；
 * 2. 于是选中底色回落到 `theme.css` 的旧蓝值 `#eef4ff`，日/夜两档同时变冷。
 *
 * 也就是说：CSS 是**静默失败**的 —— 语法错、规则被吞、页面只是"看起来不太对"，
 * `typecheck` / `lint` / 打包**一律不会报**。当时是 `accept-brand` 的
 * 「选中底不是淡朱 #f6e9e4」把它抓出来的（验收在这件事上是对的）。
 *
 * 但那要靠跑浏览器才知道。这条守卫把判据提前到**字节层**：注释必须闭合、
 * `{` 必须配平，谁改坏了 `pnpm test` 就直接红。
 */
const ROOT = path.resolve(__dirname, "..");
const SKIP_DIRS = new Set(["node_modules", "dist", "dist-electron", "release", "data", ".verify", ".git"]);

function collectCss(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) collectCss(full, out);
    else if (entry.name.endsWith(".css")) out.push(full);
  }
  return out;
}

/**
 * 逐字符过一遍 CSS，返回人话描述的违例（空数组 = 干净）。
 *
 * 不能用正则数 `/*` 和 `*​/`：那样只能发现"数量不等"，
 * 说不出是**哪个文件第几行**没闭合 —— 而排查时恰恰需要这一句。
 * 顺手把字符串里的花括号跳过（属性选择器 `[data-x="{"]` 里可能出现）。
 */
export function scanCss(text: string): string[] {
  const issues: string[] = [];
  let line = 1;
  let depth = 0;
  let commentLine = 0;
  let i = 0;
  while (i < text.length) {
    const two = text.slice(i, i + 2);
    const c = text[i];
    if (commentLine) {
      if (two === "*/") {
        commentLine = 0;
        i += 2;
        continue;
      }
      /*
       * ★ 这条才是真能抓住那次事故的：**CSS 注释不嵌套**。
       * 一旦在注释里又冒出一个「开注释符」，说明前面某个「闭注释符」丢了 ——
       * 丢了之后两段注释会首尾相接成一个：里层的闭注释符提前关掉外层，
       * 夹在中间的规则就整段被吞。只数开闭个数是**抓不住**的：
       * 那次开 48 闭 47，正是里层的闭注释符顶了外层，走一遍反而「配平」。
       *
       * ⚠️ 这段注释本身就把这个坑踩了一遍：写 `斜杠星号` 的时候真写了两个字符，
       * 于是这段注释在那一行就结束了，剩下的散文被当成 TS 代码 —— esbuild 当场报
       * `Unterminated regular expression`。**TS 有编译器兜底，CSS 没有**，所以
       * 这条守卫存在。改这段散文时别手滑。
       */
      if (two === "/*") issues.push(`${line} 行的 /* 落在注释里 —— 前面有段注释被截断了，中间那些规则会被整段吞掉`);
      if (c === "\n") line++;
      i++;
      continue;
    }
    if (two === "/*") {
      commentLine = line;
      i += 2;
      continue;
    }
    if (two === "*/") {
      issues.push(`${line} 行有个没配对的 */`);
      i += 2;
      continue;
    }
    if (c === '"' || c === "'") {
      const quote = c;
      i++;
      while (i < text.length && text[i] !== quote) {
        if (text[i] === "\\") i++;
        if (text[i] === "\n") line++;
        i++;
      }
      i++;
      continue;
    }
    if (c === "\n") line++;
    else if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth < 0) {
        issues.push(`${line} 行多了个没配对的 }`);
        depth = 0;
      }
    }
    i++;
  }
  if (commentLine) issues.push(`${commentLine} 行的 /* 一直没闭合 —— 它后面整段规则都被吞了`);
  if (depth > 0) issues.push(`文件尾还有 ${depth} 个 { 没闭合`);
  return issues;
}

describe("CSS 完整性（注释闭合 + 花括号配平）", () => {
  const files = collectCss(path.join(ROOT, "src"));

  it("扫描范围不是空的（守卫本身别成了空扫描）", () => {
    expect(files.length).toBeGreaterThan(5);
    const rules = files.reduce((n, f) => n + (readFileSync(f, "utf8").match(/\{/g)?.length ?? 0), 0);
    expect(rules).toBeGreaterThan(300);
  });

  it("每个 CSS 的注释与花括号都配平", () => {
    for (const f of files) {
      const rel = path.relative(ROOT, f).replace(/\\/g, "/");
      expect(scanCss(readFileSync(f, "utf8")), `${rel} 破了`).toEqual([]);
    }
  });

  /**
   * 守卫**必须能红**：拿三个真实形态的坏样本喂给它，全都要报出来。
   * （钉住的是"上报能力"，不是措辞：只断言非空。）
   */
  it("坏样本必须被抓住（否则这条守卫就是装饰）", () => {
    const good = "/* 好注释 */\n.wb { color: red; }\n.wb-x { background: \"{a}\"; }\n";
    expect(scanCss(good)).toEqual([]);
    const unterminated = "/* 没闭合的注释\n.wb { --t: 1; }\n";
    expect(scanCss(unterminated).length, "注释没闭合").toBeGreaterThan(0);
    const missingBrace = ".wb { color: red;\n";
    expect(scanCss(missingBrace).length, "花括号没闭合").toBeGreaterThan(0);
    const strayClose = ".wb { color: red; } */\n";
    expect(scanCss(strayClose).length, "孤儿 */").toBeGreaterThan(0);
    /* 2026-10-16 那次事故的原样：注释被截断，后面紧跟的注释把这个洞"接"上了 */
    const truncated = "/* 适配 C：……（写了一半\n\n[data-theme=\"dark\"] .wb {\n  --t: 1;\n}\n\n/* 下一段注释 */\n";
    expect(scanCss(truncated).length, "注释被截断（里层又冒出 /*）").toBeGreaterThan(0);
  });
});
