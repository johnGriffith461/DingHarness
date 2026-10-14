import { readFileSync, readdirSync } from "node:fs";

/*
 * ⚠️ C6-3 把 `src/styles.css`（6015 行）按区域拆成了 `src/styles/*.css` + 一串 `@import`。
 * 这条守卫原来**只读那一个文件** —— 拆分之后它扫了个空，于是"看起来还在检查"其实什么都没查
 * （`themeRatchet` 甚至直接报"两类都要非平凡"，那正是"检查在空转"的自白）。
 *
 * 现在读**整个样式树**：入口 + `src/styles/` 下全部 css（按文件名排序，顺序无关紧要，
 * 因为这些守卫是在"找某条规则/某个变量在不在"，不是在比层叠顺序）。
 */
function readAllCss(dir = "src"): string {
  const files = [`${dir}/styles.css`, ...readdirSync(`${dir}/styles`).filter((f) => f.endsWith(".css")).sort().map((f) => `${dir}/styles/${f}`)];
  return files.map((f) => readFileSync(f, "utf8")).join("\n");
}
import { describe, expect, it } from "vitest";

/**
 * 保真锁定：工作台那三档低对比度文字色 —— 改动必须是**显式决定**，不是顺手。
 *
 * ## 来历
 * 这三档最早是**参考应用的取值**（白底 2.61 / 1.91 / 1.70:1，**全部低于 AA**）。
 * 那时任务目标是"一比一复刻"，所以选保持，但把值钉进测试：只提成变量、不动数，
 * 想改它就得先过这一关。
 *
 * 2026-10-14 一天里做了**两次有意的重定档**（正是上面说的那种情形）：
 *   ① 可访问性重定档：低于 AA 的表现是空态、时间戳、占位文字白得看不见
 *      → 调到 4.97 / 4.74 / 4.10（并写明"这是有意偏离参考"）。
 *   ② **Dingwork 视觉系统落地**：日间改「纸白 + 墨」，三档换**暖**色相
 *      （冷灰落在纸白上是脏的 —— 提案 §04「暖墨投影」同一条道理）。
 *
 * ⚠️ 第二次的值**不是抄提案里写的数**，是在同一张纸白底（`#fbfaf7`）上
 * 按 WCAG 公式现算的；算完才发现换色相当天 dim / faint 其实是**升的**：
 *
 * | 变量 | 用途 | 暖墨（现行） | 上一版（冷灰） | 参考应用（原始） |
 * |---|---|---|---|---|
 * | `--fg-dim` | 次要说明文字 | **5.19:1** ✓AA | 4.77:1 ✓AA | 2.61:1 ✗ |
 * | `--fg-faint` | 更淡的图标/文字 | **4.66:1** ✓AA | 4.54:1 ✓AA | 1.91:1 ✗ |
 * | `--fg-ghost` | 占位、分隔符（装饰） | **3.13:1** ✓过 UI 底线 | 3.92:1 ✓ | 1.70:1 ✗ |
 *
 * 结论：**三档一起调**、且仍是「AA / AA / 只做装饰」的层次结构 —— 层次没断，
 * 也没有哪一档掉到自己的底线以下（ghost 是装饰用的，口径是 3:1）。
 */


/**
 * 现行取值（改这里 = 显式选择偏离当前设计系统）。
 *
 * ⚠️ 2026-10-14 起是 **Dingwork 日间「纸白 + 墨」** 的三档。
 * 权威定义在 `src/styles/dingwork-tokens.css` 的 `.wb` 块 ——
 * 本测试读的是合并后的样式树，按文件名排序，那个文件排在最前，所以读到的是它。
 */
const REFERENCE = {
  "--fg-dim": "#6e6a5c",
  "--fg-faint": "#767165",
  "--fg-ghost": "#948e7d",
};

/**
 * 读 `.wb` 变量块里这几个变量的当前取值。
 *
 * @param text 样式表全文
 * @returns 变量名 → 值
 */
function readInk(text: string): Record<string, string> {
  const found: Record<string, string> = {};
  for (const m of text.matchAll(/\.wb \{([^}]*)\}/g)) {
    const body = m[1];
    if (!body.includes("--bg:")) continue;
    for (const d of body.matchAll(/(--[a-z0-9-]+):\s*(#[0-9a-fA-F]{3,8})/g)) {
      if (d[1] in REFERENCE) found[d[1]] = d[2].toLowerCase();
    }
    break;
  }
  return found;
}

describe("保真锁定：三档低对比度文字色与参考一致", () => {
  it("**取值没有被改动**（改动它等于显式选择偏离参考）", () => {
    const actual = readInk(readAllCss());
    const diff = Object.entries(REFERENCE)
      .filter(([name, value]) => actual[name] !== value)
      .map(([name, value]) => `${name}: 期望 ${value}，实际 ${actual[name] ?? "(未声明)"}`);

    expect(
      diff,
      [
        "工作台的低对比度文字色被改动了。",
        "这三个值是参考应用的取值，改动它会让界面不再与参考一致（这次任务的目标是一比一）。",
        "如果这是一次**有意的可访问性改版**：请三档一起调（它们是一个层次体系），",
        "并同时更新 themeInk.test.ts 里的 REFERENCE 与上面的对比度表。",
        diff.join("\n"),
      ].join("\n"),
    ).toEqual([]);
  });

  it("三档确实都还在（少了任何一档，层次体系就断了）", () => {
    const actual = readInk(readAllCss());
    expect(Object.keys(actual).sort()).toEqual(Object.keys(REFERENCE).sort());
  });
});
