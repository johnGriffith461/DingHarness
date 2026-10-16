import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * 守卫：**模型改写往返期间，用户打的字不许被吃掉**（2026-10-16，审计 P87）。
 *
 * 修前实测的形态：`runAction` 发起前抓一份正文进请求，回来用模型那段**整篇覆盖**；
 * 而正文输入框既没有 `disabled` 也没有 `readOnly`（`busy` 只挡住了操作条那四颗按钮）——
 * 于是"点润色 → 等 → 期间顺手改两句 → 回来一看改动没了"。静默覆盖是这件事里最坏的部分。
 *
 * 两层一起判（都是源码级 —— 这一层没有渲染环境，与仓库里其它组件守卫同一手法）：
 *   · 面板：往返期间正文**只读**（改不了就丢不了），而且 title 要说清为什么；
 *   · store：**兜底** —— 正文在往返期间真被改过时不许覆盖，要把模型那段存成另一版并说明。
 */
const ROOT = path.resolve(__dirname, "..", "..");

function read(rel: string): string {
  const text = readFileSync(path.join(ROOT, rel), "utf8");
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

describe("文档改写的往返（P87）", () => {
  it("⭐ 面板：往返期间正文只读，并说明原因", () => {
    const src = read("src/workbench/DocPanel.tsx");
    const at = src.indexOf('data-testid="wb-doc-body"');
    expect(at, "正文输入框不见了").toBeGreaterThan(-1);
    const segment = src.slice(at, at + 900);
    expect(segment, "正文输入框没有 readOnly={busy} —— 改写期间照旧能打字，回来就被覆盖").toContain("readOnly={busy}");
    expect(segment, "只读时要说明为什么（不然用户以为输入框坏了）").toMatch(/title=\{busy \?/);
  });

  it("⭐ store：正文在往返期间被改过时不许覆盖（存成另一版 + 说明）", () => {
    const src = read("src/workbench/docStore.ts");
    const at = src.indexOf("runAction: async (id, action) => {");
    expect(at, "找不到 runAction").toBeGreaterThan(-1);
    const segment = src.slice(at, src.indexOf("exportDoc:", at));
    expect(segment, "发起时要记下当时那份正文（用来比一比）").toContain("const sentFrom = doc.body");
    expect(segment, "要拿现在的正文与发起时比").toMatch(/now\.body !== sentFrom/);
    expect(
      segment,
      "被改过时**不能**直接覆盖 —— 模型那段要存成另一个版本",
    ).toContain("改写期间的版本，未覆盖你改的");
    expect(segment, "并且要如实告诉用户发生了什么（静默覆盖是最坏的部分）").toMatch(/note:.*保留了/);
  });
});
