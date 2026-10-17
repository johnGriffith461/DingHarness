import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * **L06 个性化的接线守卫**（源码级 —— 这一层没有渲染环境）。
 *
 * 挡的是三类"做了一半"：
 * ① 键位只改了提示、没改判定（或反过来）—— 用户按下去到不了那个页面；
 * ② 人格设置存下来了，但**没进系统提示词**（用户设了等于没设）；
 * ③ 个性化顺手改了界面排版/配色（可读性成了个人偏好的牺牲品）。
 */

const ROOT = path.resolve(__dirname, "..", "..");
const read = (rel: string): string => readFileSync(path.join(ROOT, rel), "utf8");

describe("键位：提示与判定同源", () => {
  const workbench = read("src/workbench/Workbench.tsx");
  const sidebar = read("src/workbench/NavSidebar.tsx");

  it("Workbench 的命令面板键位来自键位表（不许再写死 k）", () => {
    expect(workbench, "命令面板键位还在写死 e.key === \"k\"").not.toMatch(/toLowerCase\(\)\s*!==\s*["']k["']/);
    expect(workbench).toContain("matchKeyAction(e, keymapNow())");
  });

  it("导航键位来自 matchShortcut（它会读当前键位表）", () => {
    expect(workbench).toContain("matchShortcut(e)");
  });

  it("左栏提示在**渲染时**算（不是模块加载时算一次）", () => {
    expect(sidebar, "NAV 里又写死了 shortcut 字段 —— 改键位后提示不会变").not.toMatch(/shortcut:\s*shortcutFor\(/);
    expect(sidebar).toContain("shortcutFor(item.view, keymap)");
  });
});

describe("人格：只进提示词，不改界面", () => {
  it("任务启动时把人格拼进系统提示词（设了要真生效）", () => {
    const runtime = read("src/workbench/taskRuntime.ts");
    expect(runtime).toContain("personaPromptBlock(personaNow())");
  });

  it("设置页真的渲染了个性化面板", () => {
    const pages = read("src/workbench/SettingsPages.tsx");
    expect(pages).toContain("<PersonalizePanel />");
  });

  it("个性化面板**不许**写内联字号/颜色（可读性不随偏好漂）", () => {
    const panel = read("src/workbench/PersonalizePanel.tsx");
    expect(panel, "面板里出现了内联 style —— 个性化不该碰排版").not.toMatch(/style=\{\{/);
  });

  it("主题只给三档（没有任意配色：那一定会有看不清的组合）", () => {
    const theme = read("src/workbench/theme.ts");
    const options = /THEME_OPTIONS[\s\S]*?\];/.exec(theme)?.[0] ?? "";
    expect([...options.matchAll(/value:\s*"(system|light|dark)"/g)]).toHaveLength(3);
  });
});
