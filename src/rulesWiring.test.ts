import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * **「总是允许」必须接进每一次聊天回合**（装配守卫）。
 *
 * ## 这条挡的是什么（真发生过）
 *
 * 规则层（U03）单测全绿、设置层单测全绿、批准后执行那条路也读规则 ——
 * 唯独 `electron/ipc/ai.ts` 建引擎时**没把 `currentPermissionRules()` 传进去**。
 * 后果：点「总是允许」之后，下一轮同样的调用**照样再问一遍**，
 * 而所有单测都在绿（它们各自只看自己那一层）。
 *
 * 装配漏一项 = 整条功能不存在。这类缺陷只能用"看装配线"的守卫挡。
 */

const ROOT = path.resolve(__dirname, "..");
const read = (rel: string): string => readFileSync(path.join(ROOT, rel), "utf8");

describe("权限规则的装配", () => {
  it("聊天回合建引擎时真的带上规则", () => {
    const ai = read("electron/ipc/ai.ts");
    expect(ai, "ai.ts 没读 currentPermissionRules —— 「总是允许」不会进聊天回合").toContain("currentPermissionRules");
    const engine = /createEngine\(\{[\s\S]*?\n      \}\);/.exec(ai)?.[0] ?? "";
    expect(engine.length, "找不到 ai.ts 里建引擎那一段（守卫的判据失效了）").toBeGreaterThan(100);
    expect(engine, "createEngine 的入参里没有 rules").toContain("rules: currentPermissionRules()");
  });

  it("放行后执行那条路也带规则（两处同一份实现）", () => {
    const tools = read("electron/ipc/tools.ts");
    expect(tools).toContain("currentPermissionRules()");
  });

  it("桌面与 CLI 用的是同一份规则语义（都走 engine 的 decideCall）", () => {
    /* 装配层不许自己判规则：一旦某处手写匹配，"同一张规则表两种行为"就回来了 */
    const tools = read("electron/ipc/tools.ts");
    const ai = read("electron/ipc/ai.ts");
    for (const src of [tools, ai]) {
      expect(src, "装配层出现了手写的规则判定 —— 规则语义只许在 engine/core/permissionRules.ts").not.toMatch(
        /function\s+\w*[Rr]ule\w*Match/,
      );
    }
  });
});
