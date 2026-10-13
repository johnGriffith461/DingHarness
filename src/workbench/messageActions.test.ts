import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * 机械约束：**消息操作栏的每个动作都必须接了 onClick**。
 *
 * ## 这是 §36 那个 bug 的形状
 * 六个图标（复制 / 朗读 / 有帮助 / 没帮助 / 分享 / 重新生成）里，
 * **只有「复制」是活的**，其余五个点了没反应。
 *
 * 那比不放这些图标更糟：用户会以为功能坏了，或者以为自己点错了地方。
 * 而它的失效方式很隐蔽 —— **不报错、界面看起来完全正常**，
 * 只有真去点那五个才会发现。
 *
 * ## 为什么用测试钉
 * 「一排按钮里漏接一个」这种事，人眼扫代码很容易漏（那一排长得都一样）。
 * 前几轮我修过好几处同类（§34 插件「管理」、§45 设置五行），
 * 每次都是**逐个发现的**，而不是一次看全。
 *
 * 所以规则是：**`wb-actions` 里出现的每个 `<button>`，必须带 `onClick`。**
 */

const FILE = join("src", "workbench", "Workbench.tsx");

/**
 * 切出 `MessageActions` 那个函数的函数体。
 *
 * @param text 源码
 * @returns 函数体；找不到返回 null
 */
function messageActionsBody(text: string): string | null {
  const start = text.indexOf("function MessageActions(");
  if (start === -1) return null;
  // 函数体的结束：下一个顶层 `function ` 或 `/**` 之前
  const rest = text.slice(start);
  const nextFn = rest.indexOf("\nfunction ", 1);
  return nextFn === -1 ? rest : rest.slice(0, nextFn);
}

describe("消息操作栏：每个动作都要能点", () => {
  it("**wb-actions 里的每个 button 都带 onClick**", () => {
    const body = messageActionsBody(readFileSync(FILE, "utf8"));
    expect(body, "找不到 MessageActions —— 这条测试就是假的").not.toBeNull();

    const source = body ?? "";
    const offenders: string[] = [];
    // 逐个切 button 标签
    const buttonRe = /<button\b([\s\S]*?)>/g;
    let match: RegExpExecArray | null;
    while ((match = buttonRe.exec(source)) !== null) {
      const attrs = match[1];
      if (!/\bonClick=/.test(attrs)) {
        const label = /title="([^"]*)"/.exec(attrs)?.[1] ?? attrs.trim().slice(0, 40);
        offenders.push(`未接 onClick 的动作：「${label}」`);
      }
    }

    expect(offenders, ["消息操作栏里有点了没反应的动作（§36 那个 bug 的形状）：", offenders.join("\n")].join("\n")).toEqual(
      [],
    );
  });

  it("这条约束确实作用在真实的动作栏上（不是空扫描）", () => {
    const body = messageActionsBody(readFileSync(FILE, "utf8")) ?? "";
    const buttons = [...body.matchAll(/<button\b/g)].length;
    // 实机是六个动作；少于 4 说明切错了范围，这条测试就没有意义
    expect(buttons).toBeGreaterThanOrEqual(4);
  });
});
