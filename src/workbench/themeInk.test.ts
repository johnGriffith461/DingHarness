import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * 保真锁定：工作台那三档低对比度文字色，**保持与参考实现一致**。
 *
 * ## 为什么要有这条（以及它为什么不是普通的"别改颜色"）
 * 实测（WCAG 对比度，白底）：
 *
 * | 变量 | 用途 | 对比度 | AA 4.5:1 |
 * |---|---|---|---|
 * | `--fg-dim` | 次要说明文字 | **2.61:1** | ✗ |
 * | `--fg-faint` | 更淡的图标/文字 | **1.91:1** | ✗ |
 * | `--fg-ghost` | 占位、分隔符 | **1.70:1** | ✗ |
 *
 * 这三档明显低于 AA，而它们是**承载信息的**（不只装饰）。
 * 但它们是**参考应用的设计取值** —— 我只把值提成了变量，没动过数。
 *
 * 所以这里有一个**真实的取舍**：
 *   · 改成满足 AA → 界面比参考"更清楚"，但**不再是一比一**；
 *   · 保持不变   → 与参考一致，但可访问性有欠账。
 *
 * 这次任务的目标是**一比一复刻**，所以选保持 —— 但必须让它成为
 * **一次显式的决定**，而不是被谁"顺手改好"。
 *
 * 真要提升可访问性时：**三档一起调**（它们是一个层次体系，
 * 单改一档会让"次要/更淡/占位"分不出来），并同时更新本节与下面的期望值。
 */

const CSS = "src/styles.css";

/** 参考取值（改这里 = 显式选择偏离参考）。 */
const REFERENCE = {
  "--fg-dim": "#9aa1ab",
  "--fg-faint": "#b6bcc4",
  "--fg-ghost": "#c2c7ce",
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
    const actual = readInk(readFileSync(CSS, "utf8"));
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
    const actual = readInk(readFileSync(CSS, "utf8"));
    expect(Object.keys(actual).sort()).toEqual(Object.keys(REFERENCE).sort());
  });
});
