import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { draftKeyOf } from "./composerDraft";

/**
 * 守卫：**切页不许把输入区的草稿弄丢**（2026-10-16，审计 P84）。
 *
 * 修前实测：草稿是 `Composer` 的组件内 state，而 `Workbench` 按 view **整体换组件** ——
 * 在输入框里写着东西、按 Ctrl+N（或点左栏）切个页，回来一看**整段话没了**。
 * 而且导航快捷键那一段**没有焦点判定**（Esc 那段有，所以看着像已经处理了）：
 * 打字打到一半顺手按 Ctrl+N 就直接切页。
 *
 * 两半判据：
 *   · **行为**（可测的那半）：草稿键的算法 —— 同一处回来拿到同一串、不同对话各一份；
 *   · **源码**：草稿必须取自 store；导航快捷键必须有焦点判定。
 *     （组件那一层这个仓没有渲染环境，所以这两条用源码守卫钉 —— 与仓库里其它组件守卫同一手法。）
 */
const ROOT = path.resolve(__dirname, "..", "..");

function read(rel: string): string {
  const text = readFileSync(path.join(ROOT, rel), "utf8");
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

describe("输入区草稿（P84）", () => {
  it("草稿键：同一段对话回来拿到同一串；不同对话各一份", () => {
    expect(draftKeyOf("task", "t1")).toBe("task:t1");
    expect(draftKeyOf("task", "t1")).toBe(draftKeyOf("task", "t1"));
    expect(draftKeyOf("task", "t1")).not.toBe(draftKeyOf("task", "t2"));
  });

  it("草稿键：非对话视图按 view 分（首页那份不该跑进对话里）", () => {
    expect(draftKeyOf("home", null)).toBe("home");
    expect(draftKeyOf("home", "t1"), "首页有自己的那份，与当前是哪段对话无关").toBe("home");
    expect(draftKeyOf("scheduled", null)).toBe("scheduled");
  });

  it("草稿键：对话视图但还没任务 id 时也要有稳定的键（不许出现 task:null 这种）", () => {
    expect(draftKeyOf("task", null)).toBe("task");
    expect(draftKeyOf("task", undefined)).toBe("task");
  });

  it("⭐ 源码守卫：草稿取自 store（不是组件内 state——那正是丢了的原因）", () => {
    const src = read("src/workbench/Composer.tsx");
    expect(src, "草稿要从 store 里读（按 draftKey 分开）").toContain("s.composerTexts[draftKey]");
    expect(src, "写入要走 store 的 setComposerText").toContain("setComposerText(draftKey, next)");
    expect(
      /const \\[text, setText\\] = useState\\(""\\)/.test(src),
      "草稿又变回组件内 state 了 —— 换视图会把它整段丢掉",
    ).toBe(false);
  });

  it("⭐ 源码守卫：导航快捷键必须先判焦点（打字时不许被抢）", () => {
    const src = read("src/workbench/Workbench.tsx");
    const at = src.indexOf("const onKey = (e: KeyboardEvent) => {");
    expect(at, "找不到导航快捷键的处理函数").toBeGreaterThan(-1);
    /* 取这一段（到 setView(to) 为止），确认焦点判定在 matchShortcut **之前** */
    const segment = src.slice(at, src.indexOf("setView(to);", at));
    const focusAt = segment.indexOf("isContentEditable");
    const matchAt = segment.indexOf("matchShortcut(e)");
    expect(focusAt, "导航快捷键那一段里没有焦点判定 —— 在输入框里按 Ctrl+N 会直接切页丢草稿").toBeGreaterThan(-1);
    expect(matchAt, "找不到 matchShortcut 调用").toBeGreaterThan(-1);
    expect(focusAt, "焦点判定必须在 matchShortcut **之前**（放后面等于没判）").toBeLessThan(matchAt);
  });
});
