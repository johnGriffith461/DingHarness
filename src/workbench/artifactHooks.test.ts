import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * 机械约束：产物卡的**两个钩子必须成对出现**。
 *
 * ## 这是 §43 那个 bug 的形状
 * 同一份产物渲染在**两处**（对话流卡片 + 右侧「对话产物」列表），
 * 我当初只给其中一处加了 `data-artifact-resource-type`。
 * 结果：同一个产物，在对话流里查是 `docx`，在右侧面板里查就是"没有类型" ——
 * 靠这个属性做的检查会随"看的是哪一处"而结论不同。
 *
 * ## 为什么用测试钉
 * 它的失效方式很隐蔽：**不报错、不崩、当次会话的界面看起来完全正常**。
 * 只有真的去读那个属性、而且恰好读到没加的那一处，才会发现。
 * 注释在这里没用 —— 加属性的人不会看到另一处的注释。
 *
 * 所以规则是：**凡是写了 `data-office-artifact-card-kind` 的地方，
 * 同一条 JSX 元素上必须也有 `data-artifact-resource-type`。**
 */

/** 递归列出 .tsx（跳过测试文件本身）。 */
function tsxFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      out.push(...tsxFiles(full));
      continue;
    }
    if (!/\.tsx$/.test(name)) continue;
    if (/\.test\.tsx$/.test(name)) continue;
    out.push(full);
  }
  return out;
}

/**
 * 把源码切成"属性块"：从 `data-office-artifact-card-kind` 那一行起，
 * 往回找它所属的开始标签，往前找该标签的结束 `>`。
 *
 * 不追求完整的 JSX 解析 —— 只要能把"属性是否在同一个标签里"这件事查对就够了。
 *
 * @param text 源码
 * @returns 每个出现处的上下文片段
 */
function attributeBlocks(text: string): string[] {
  const blocks: string[] = [];
  const marker = "data-office-artifact-card-kind";
  let from = 0;
  while (true) {
    const at = text.indexOf(marker, from);
    if (at === -1) break;
    // 往回找最近的 '<'（开始标签）
    const start = text.lastIndexOf("<", at);
    // 往前找该标签的结束 '>'（属性块里不会出现裸 '>'）
    const end = text.indexOf(">", at);
    blocks.push(text.slice(start === -1 ? at : start, end === -1 ? text.length : end + 1));
    from = at + marker.length;
  }
  return blocks;
}

describe("产物卡的两个钩子必须成对出现", () => {
  it("**写了 kind 的地方，同一条元素上必须有 resource-type**", () => {
    const offenders: string[] = [];
    for (const file of tsxFiles("src")) {
      const text = readFileSync(file, "utf8");
      for (const block of attributeBlocks(text)) {
        if (!block.includes("data-artifact-resource-type")) {
          const line = text.slice(0, text.indexOf(block)).split("\n").length;
          offenders.push(`${file}:约第 ${line} 行 —— 只有 kind，没有 resource-type`);
        }
      }
    }
    expect(
      offenders,
      [
        "有产物卡只给了 data-office-artifact-card-kind、没给 data-artifact-resource-type（§43 那个 bug 的形状）。",
        "同一份产物在多处渲染，两个钩子必须成对 —— 只给一处的话，",
        "靠这个属性做的检查会随「看的是哪一处」而结论不同。",
        offenders.join("\n"),
      ].join("\n"),
    ).toEqual([]);
  });

  it("这条约束确实作用在真实的渲染点上（不是空扫描）", () => {
    /*
     * ⚠️ §186 产物卡片抽成了独立组件（`ArtifactCard.tsx`，聊天也要用同一个），
     * 所以"两处渲染"现在分在两个文件里：
     *   - `ArtifactCard.tsx` —— 对话流里的卡片（工作台与聊天共用）
     *   - `Workbench.tsx`    —— 右侧「对话产物」列表
     * 断言改成**两边加起来**至少两处，并且每一处都成对。
     */
    /*
     * ⚠️ C6-1 之后右侧「对话产物」列表搬去了 `SummaryPanel.tsx`（`Workbench.tsx` 只剩外壳）。
     * 这条守卫盯"钩子成对出现在哪些渲染点"，所以得跟着搬家走 ——
     * 漏改的表现是"空扫描"（`files` 里那份文件里再也没有钩子，断言却仍然绿/红得莫名其妙）。
     */
    const files = ["ArtifactCard.tsx", "SummaryPanel.tsx"].map((name) =>
      readFileSync(join("src", "workbench", name), "utf8"),
    );
    const blocks = files.flatMap((text) => attributeBlocks(text));
    // 少 2 处说明扫描没覆盖到，这条测试就是假的
    expect(blocks.length).toBeGreaterThanOrEqual(2);
    expect(blocks.every((b) => b.includes("data-artifact-resource-type"))).toBe(true);
  });
});
