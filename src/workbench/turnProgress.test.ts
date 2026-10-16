import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { usageTotal } from "@shared/cost";

/**
 * 守卫：**进度行里的"已用 token"必须是累计的**（2026-10-16，审计 P150）。
 *
 * 修前实测：`step-finish` 每次只带**这一步**的用量，而两处进度叙述都把它当"已用"报出去 ——
 * 桌面 `taskRuntime.ts` 里那行甚至是赋值（`liveTokens = 这一步`，而变量上方注释写的是"累计"），
 * CLI（`hosts/cli/ding.ts`）同形。同一轮的账本是**逐步累加**的（`done` 事件的 usage），
 * 于是进度行与账本差一倍以上：用户看着"已用 1.2万"，账本上是 2.4万。
 *
 * 判据两半：
 *   · **行为**：`usageTotal` 的口径（一个数都没有 → null，界面就不显示数，不编 0）；
 *   · **源码**：两处进度叙述都要**累加**（`+=`）且措辞写明"累计"。
 */
const ROOT = path.resolve(__dirname, "..", "..");  // src/workbench/ 下 → 仓根

function read(rel: string): string {
  const text = readFileSync(path.join(ROOT, rel), "utf8");
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

describe("长回合进度里的 token（P150）", () => {
  it("usageTotal：有数才给数（一个字段都没有时 null，别编 0）", () => {
    expect(usageTotal({ inputTokens: 100, outputTokens: 20 })).toBe(120);
    expect(usageTotal({ inputTokens: 100 })).toBe(100);
    expect(usageTotal({})).toBeNull();
    expect(usageTotal(undefined)).toBeNull();
  });

  it("⭐ 桌面：进度行要**累加**每一步，并写明「累计」", () => {
    const src = read("src/workbench/taskRuntime.ts");
    expect(src, "又变成赋值了（每步都覆盖 → 报的是「这一步用了多少」）").not.toMatch(/liveTokens\s*=\s*\n?\s*\(event\.usage/);
    expect(src, "要累加").toContain("liveTokens += stepTokens");
    expect(src, "文案要写明是累计（免得又被读成「这一步」）").toContain("累计已用");
  });

  it("⭐ CLI：同一处口径（同字段、同累加、同措辞）", () => {
    const src = read("hosts/cli/ding.ts");
    expect(src, "CLI 进度也要累加").toContain("totalTokens += stepTokens");
    expect(src, "措辞与桌面一致").toContain("累计已用");
    expect(src, "两边读的是同一个字段（usageTotal）").toContain("usageTotal(event.usage)");
  });
});
