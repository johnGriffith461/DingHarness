import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * 可访问性基线（G16，2026-10-18）。
 *
 * 全量 a11y 审计要真浏览器 + 屏幕阅读器；这里先钉两条**能机器判、且最容易退化**的：
 * ① 只有图标的按钮必须有可访问名（aria-label / title / aria-labelledby / 可见文字）；
 * ② **长得像控件**的 div 不许用 onClick 冒充（遮罩/画布容器这类不是控件，放过）。
 * 焦点环那条在 `src/stylesAudit.test.ts`（已有），这里不重复。
 */

const ROOT = path.resolve(__dirname, "..");
const SRC = path.join(ROOT, "src");

function collect(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) collect(full, out);
    else if (/\.tsx$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(full);
  }
  return out;
}

/** 去注释（判定前必须做：注释里会提到这些写法）。 */
function strip(src: string): string {
  return src
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

/** 相对路径（统一用正斜杠）。 */
function relOf(file: string): string {
  return path.relative(ROOT, file).split(path.sep).join("/");
}

describe("可访问性基线（G16）", () => {
  it("⭐ 图标按钮都有可访问名（aria-label / title / aria-labelledby / 可见文字）", () => {
    const offenders: string[] = [];
    for (const file of collect(SRC)) {
      const code = strip(readFileSync(file, "utf8"));
      for (const m of code.matchAll(/<button\b[^>]*>/g)) {
        const tag = m[0];
        if (/aria-label|aria-labelledby|title=/.test(tag)) continue;
        const after = code.slice(m.index! + tag.length, m.index! + tag.length + 200);
        const inner = after.split("</button>")[0] ?? "";
        if (/[\u3400-\u9fff\w]/.test(inner)) continue;
        offenders.push(`${relOf(file)}: ${tag.slice(0, 80)}`);
      }
    }
    expect(offenders, `这些按钮没有可访问名：\n${offenders.join("\n")}`).toEqual([]);
  });

  it("⭐ 长得像控件的 div 不许用 onClick 冒充按钮", () => {
    const controlish = /btn|button|item|row|card|tab|chip|entry|option/i;
    const exempt = /mask|backdrop|scrim|overlay|stage|canvas|pane/i;
    const offenders: string[] = [];
    for (const file of collect(SRC)) {
      const code = strip(readFileSync(file, "utf8"));
      for (const m of code.matchAll(/<div\b[^>]*onClick=[^>]*>/g)) {
        const tag = m[0];
        if (/role="button"/.test(tag) && /tabIndex/.test(tag)) continue;
        const cls = /className="([^"]*)"/.exec(tag)?.[1] ?? "";
        if (exempt.test(cls)) continue;
        if (!controlish.test(cls)) continue;
        offenders.push(`${relOf(file)}: ${tag.slice(0, 80)}`);
      }
    }
    expect(offenders, `这些 div 用 onClick 冒充按钮：\n${offenders.join("\n")}`).toEqual([]);
  });
});
