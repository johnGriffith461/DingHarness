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
 * 不变量：**画布规则引用的每个变量，`.wb-canvas` 都得自己声明**。
 *
 * ## 它挡的是什么
 * `.wb-canvas` 嵌在 `.wb` 里面，所以它会**继承** `.wb` 的变量值 —— 而那些是**浅色**。
 * 一旦有画布规则写成 `var(--fg-2)` 之类，而 `.wb-canvas` 没声明 `--fg-2`，
 * 画布就会拿到**浅色**，深色画布上出现浅色文字/边框。
 *
 * 这是这个项目里反复出现的同一类问题（§43 / §49 / §52 / §63）：
 * **改一处、与它配对的另一处没跟上**。而它的失效方式很隐蔽 ——
 * 不报错、不崩，只是**某处颜色不对**，得盯着看才发现。
 *
 * ## 为什么写成不变量而不是棘轮
 * 写成"画布不许用 var(--)"会**挡住以后做深色主题**（那正是要用变量的）。
 * 写成"引用了就必须声明"则**永远成立**：今天成立（画布 0 处引用），
 * 将来把画布改成用变量时也成立 —— 只要声明补齐。
 *
 * 所以这条守卫的正确形态是**配对检查**，不是禁止。
 */


/** 从一段声明文本里取出变量名。 */
function declaredIn(body: string): string[] {
  return [...body.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1]);
}

/** 从一段声明文本里取出被引用的变量名。 */
function usedIn(body: string): string[] {
  return [...body.matchAll(/var\(\s*(--[a-z0-9-]+)/g)].map((m) => m[1]);
}

/**
 * 解析与画布相关的两块信息。
 *
 * @param text 样式表全文
 * @returns `declared` = .wb-canvas 自己声明的变量；`used` = 画布规则引用的变量（去重）
 */
function readCanvas(text: string): { declared: Set<string>; used: Set<string> } {
  const declared = new Set<string>();
  const used = new Set<string>();

  const rules = [...text.matchAll(/([^{}]+)\{([^{}]*)\}/g)];
  for (const rule of rules) {
    const selector = rule[1];
    const body = rule[2];
    if (!selector.includes("wb-canvas")) continue;
    for (const name of declaredIn(body)) declared.add(name);
    for (const name of usedIn(body)) used.add(name);
  }
  return { declared, used };
}

describe("画布变量必须自给自足", () => {
  it("**画布引用的每个 var(--X)，.wb-canvas 都要自己声明**", () => {
    const { declared, used } = readCanvas(readAllCss());
    const missing = [...used].filter((name) => !declared.has(name));
    expect(
      missing,
      [
        `画布规则引用了 ${missing.join(", ")}，但 .wb-canvas 没声明它。`,
        "它会在 .wb 里取到**浅色**值（画布嵌在工作台里），深色画布上就会出现浅色元素。",
        "做法：把 .wb-canvas 的变量块补上这些名字的**深色值**。",
      ].join("\n"),
    ).toEqual([]);
  });

  it("这条检查确实作用在画布上（.wb-canvas 的变量块被找到了）", () => {
    const { declared } = readCanvas(readAllCss());
    // 画布块至少有它原有的 6 个，否则说明选择器解析坏了、这条守卫是假的
    expect(declared.size).toBeGreaterThanOrEqual(6);
    expect(declared.has("--bg")).toBe(true);
    expect(declared.has("--fg")).toBe(true);
  });

  /*
   * 这条记录的是**当前实况**，变了就该改这里（它自己的注释就是这么说的）。
   *
   * 2026-10-14 从 0 变 1：画布左边缘加了边界阴影 `var(--edge-shadow-left)` ——
   * 上面那条"引用了什么就必须声明什么"因此真的开始工作了（这正是加它的意义：
   * 画布是深色孤岛，借工作台的浅色变量会在深底上糊掉）。
   */
  it("画布引用到的变量数（当前实况：1 个，边界阴影）", () => {
    const { used, declared } = readCanvas(readAllCss());
    expect([...used].sort()).toEqual(["--edge-shadow-left"]);
    /* 关键那条：引用的每个都得声明过（上面那条测试的等价直白版） */
    for (const name of used) expect(declared.has(name), `${name} 没在 .wb-canvas 里声明`).toBe(true);
  });
});
