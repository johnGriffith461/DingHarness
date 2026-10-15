import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * 右侧面板守卫（2026-10-15，M0 工单 2）。
 *
 * ## 修前实测留下的三条事实（别把它们当成"猜"）
 *
 * 用户原来的报告是「右侧侧边栏面板只能开不能关」。实测（`.verify/m0/probe-panels.mjs`）发现：
 *
 *   ① 摘要面板**本来就能关** —— 2026-10-14 已修过一版（收起入口带字「收起」），本次核对通过；
 *   ② 画布对话侧栏也**能关**，而且把手热区**没被吞**（`elementFromPoint` 命中的就是它自己）、
 *      反复开合 10 次一致。它真正的毛病是**关的入口只有一颗 17px 的 `‹`** ——
 *      既容易看漏，又像"往左导航"（工单 2.2 的规格："必须可见且语义无歧义"）；
 *   ③ 两个面板**都没有 Esc**。
 *
 * 所以这一节挡的不是"关不掉"，而是**入口的可见性/语义**与 **Esc 的那三条边界** ——
 * 边界里两条是"修 bug 时最容易修出新 bug"的地方：弹窗开着时两头一起关、
 * 以及焦点在输入框里时把面板收掉（侧栏一关就**卸载**，正在写的草稿直接没了）。
 *
 * 行为侧由 `scripts/accept/accept-panels.mjs` 真点界面来挡（往返 10 次 / Esc / 热区），
 * 与 `uiCraft.test.ts` 同一个套路：**读源码挡写法，点界面挡行为，缺一层都拦不住复发**。
 */

const ROOT = path.resolve(__dirname, "..");
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");

describe("右侧面板守卫（M0 工单 2：只能开不能关 / Esc 可达）", () => {
  const wb = read("src/workbench/Workbench.tsx");
  const summary = read("src/workbench/SummaryPanel.tsx");

  it("① Esc 只由一处处理，且（剩下的）两条边界都在", () => {
    expect(wb, "Workbench 里没有 Esc 处理").toMatch(/"Escape"/);
    /* 边界一：弹窗自己处理 Esc，两头一起关会让人莫名其妙 */
    expect(wb).toMatch(/wb-modal-mask/);
    /* 边界二：焦点在输入框里不动面板（侧栏一关就卸载，草稿会丢） */
    expect(wb).toMatch(/INPUT/);
    expect(wb).toMatch(/TEXTAREA/);
    expect(wb).toMatch(/isContentEditable/);
    /*
     * 边界三「一次只关一个」原来是靠「画布对话优先」体现的；2026-10-16 那条侧栏拆了，
     * 于是它退化成一次只关一个东西——现在只剩摘要面板，所以这条断言也随之删掉。
     * ⚠️ 别把这条当成边界不需要了：**将来再加第二个可收面板时，它得回来**。
     */
  });

  it("② 面板的开关态由工作台持有（两个面板各监听一次 Esc 会互相抢）", () => {
    expect(summary, "SummaryPanel 必须受控：收起态不再自己 useState").not.toMatch(/useState\(true\)/);
    expect(summary).toMatch(/collapsed: boolean/);
    expect(summary).toMatch(/onCollapsedChange/);
    expect(wb, "Workbench 必须把收起态传下去").toMatch(/<SummaryPanel[\s\S]{0,120}collapsed=\{summaryCollapsed\}/);
  });

  /*
   * ⚠️ 2026-10-16：原来这里是两条「画布对话侧栏」的断言（收起入口在头上、带字、排在新会话之前）。
   * 主人把那条侧栏整条拆了（「为什么你还有个聊天」）—— 没有侧栏就没有可关的入口，这两条随之删掉。
   * 剩下的两条（Esc 的三条边界、摘要面板受控）仍然有效：它们盯的是**工作台**那层。
   */;
});
