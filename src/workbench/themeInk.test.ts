import { readFileSync } from "node:fs";

/*
 * ⚠️ 2026-10-16（审计 G24）：这里原来有个 `readAllCss()`，把整棵样式树按**文件名排序**拼起来读。
 * 那是**字典序**而不是层叠序 —— 而 `src/styles.css` 的注释写着"这些 `@import` 的顺序就是层叠顺序"。
 * 现在读法按 `@import` 顺序走（见 `importOrder()`），所以这个函数删掉了。
 */
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
 *   ② **Ding Harness 视觉系统落地**：日间改「纸白 + 墨」，三档换**暖**色相
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
 * ⚠️ 2026-10-14 起是 **Ding Harness 日间「纸白 + 墨」** 的三档（上面那张表）。
 *
 * ⚠️⚠️ 2026-10-16（审计 G24）：这两个表原来**只有浅色一套**，而且读法是
 * "按**文件名排序**取第一个 `.wb { --bg: … }` 块" —— 那是**字典序**，不是层叠序：
 * 谁在 `src/styles.css` 里后 `@import` 谁才真正生效（`styles.css` 的注释自己写着
 * "这些 `@import` 的顺序就是层叠顺序"）。也就是说：后导入的文件改这三个值时，
 * 守卫读到的仍是前面的旧值 → **改坏了也不红**（这正是 G24 的原话）。
 * 现在按 **`@import` 顺序**取"最后一个声明"（真正生效的那份），
 * 并把**深色那套**一起钉住（`[data-theme="dark"] .wb`）。
 */
const REFERENCE = {
  "--fg-dim": "#6e6a5c",
  "--fg-faint": "#767165",
  "--fg-ghost": "#948e7d",
} as const;

/** 深色主题下这三档的现行取值（来源：`ding-harness-tokens.css` 的 `[data-theme="dark"] .wb` 块）。 */
const REFERENCE_DARK = {
  "--fg-dim": "#948d76",
  "--fg-faint": "#837c66",
  "--fg-ghost": "#5c5647",
} as const;

/** `src/styles.css` 里的 `@import` 顺序（= 层叠顺序）。 */
function importOrder(): string[] {
  const entry = readFileSync("src/styles.css", "utf8");
  return [...entry.matchAll(/@import\s+"\.\/(styles\/[^"]+\.css)"/g)].map((m) => `src/${m[1]}`);
}

/**
 * 读**真正生效**的那套取值：按 `@import` 顺序走一遍，同一个变量**后面的覆盖前面的**。
 *
 * @param theme `light` = `.wb` 块；`dark` = `[data-theme="dark"] .wb` 块
 * @returns 变量名 → 值（含它来自哪个文件，报错时好定位）
 */
function readInk(theme: "light" | "dark"): Record<string, { value: string; file: string }> {
  const found: Record<string, { value: string; file: string }> = {};
  for (const file of importOrder()) {
    const text = readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    for (const m of text.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const selector = m[1].trim().replace(/\s+/g, " ");
      const isDark = selector.includes('[data-theme="dark"]');
      const isLight = !isDark && selector === ".wb";
      if (theme === "dark" ? !(isDark && selector.endsWith(".wb")) : !isLight) continue;
      const body = m[2];
      if (!body.includes("--bg:")) continue;
      for (const d of body.matchAll(/(--[a-z0-9-]+):\s*(#[0-9a-fA-F]{3,8})/g)) {
        found[d[1]!] = { value: (d[2] ?? "").toLowerCase(), file };
      }
    }
  }
  return found;
}

describe("保真锁定：三档低对比度文字色与参考一致", () => {
  const check = (theme: "light" | "dark", reference: Record<string, string>): string[] => {
    const actual = readInk(theme);
    return Object.entries(reference)
      .filter(([name, value]) => actual[name]?.value !== value)
      .map(
        ([name, value]) =>
          `${name}: 期望 ${value}，实际 ${actual[name]?.value ?? "(未声明)"}${
            actual[name] ? `（生效值来自 ${actual[name]!.file}）` : ""
          }`,
      );
  };

  it("**浅色取值没有被改动**（读的是层叠里真正生效的那份）", () => {
    const diff = check("light", REFERENCE);
    expect(
      diff,
      [
        "工作台的低对比度文字色被改动了（浅色）。",
        "这三个值是参考应用的取值，改动它会让界面不再与参考一致（这次任务的目标是一比一）。",
        "如果这是一次**有意的可访问性改版**：请三档一起调（它们是一个层次体系），",
        "并同时更新 themeInk.test.ts 里的 REFERENCE 与上面的对比度表。",
        diff.join("\n"),
      ].join("\n"),
    ).toEqual([]);
  });

  it("**深色取值没有被改动**（G24：原来只钉了浅色那套）", () => {
    const diff = check("dark", REFERENCE_DARK);
    expect(
      diff,
      ["工作台的低对比度文字色被改动了（深色）。", "深色那套同样是有意定过的档，改它要一起更新这张表。", diff.join("\n")].join(
        "\n",
      ),
    ).toEqual([]);
  });

  it("读法本身有效：找到的是**层叠序最后一个**声明（不是字典序第一个）", () => {
    const light = readInk("light");
    /* 三个变量都要读到，否则"没读到"会被当成"没改"悄悄放过 */
    for (const name of Object.keys(REFERENCE)) {
      expect(light[name], `${name} 没从任何 .wb 块里读到 —— 这条守卫读空了`).toBeTruthy();
    }
    const dark = readInk("dark");
    for (const name of Object.keys(REFERENCE_DARK)) {
      expect(dark[name], `深色的 ${name} 没读到`).toBeTruthy();
    }
  });

  it("三档确实都还在（少了任何一档，层次体系就断了）", () => {
    /* ⚠️ G24 之后 readInk 收的是主题（层叠序读取），不再是"一整份 CSS 文本" */
    const light = Object.keys(readInk("light")).filter((k) => k in REFERENCE);
    expect(light.sort()).toEqual(Object.keys(REFERENCE).sort());
  });
});
