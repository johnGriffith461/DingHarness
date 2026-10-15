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
  const chat = read("src/chat/ChatSidebar.tsx");

  it("① Esc 只由一处处理，且三条边界都在", () => {
    expect(wb, "Workbench 里没有 Esc 处理").toMatch(/"Escape"/);
    /* 边界一：弹窗自己处理 Esc，两头一起关会让人莫名其妙 */
    expect(wb).toMatch(/wb-modal-mask/);
    /* 边界二：焦点在输入框里不动面板（侧栏一关就卸载，草稿会丢） */
    expect(wb).toMatch(/INPUT/);
    expect(wb).toMatch(/TEXTAREA/);
    expect(wb).toMatch(/isContentEditable/);
    /* 边界三：一次只关一个 —— 画布对话优先 */
    expect(wb).toMatch(/canvasChatOpen/);
  });

  it("② 面板的开关态由工作台持有（两个面板各监听一次 Esc 会互相抢）", () => {
    expect(summary, "SummaryPanel 必须受控：收起态不再自己 useState").not.toMatch(/useState\(true\)/);
    expect(summary).toMatch(/collapsed: boolean/);
    expect(summary).toMatch(/onCollapsedChange/);
    expect(wb, "Workbench 必须把收起态传下去").toMatch(/<SummaryPanel[\s\S]{0,120}collapsed=\{summaryCollapsed\}/);
  });

  it("③ 画布对话侧栏的「收起」入口必须在头上、必须带字", () => {
    expect(chat, "侧栏没有收起入口").toMatch(/data-testid="wb-chat-collapse"/);
    expect(chat, "收起入口必须带字（图标 + 「收起」）").toMatch(/收起\s*<\/button>/);
    /* 与摘要面板同一颗样式：两个右面板长一样，用户学一次就够 */
    expect(chat).toMatch(/className="wb-summary-collapse"/);
    /* 接收 onClose 并由工作台传进来（侧栏自己管不了画布的开关态） */
    expect(chat).toMatch(/onClose\?\.\(\)/);
    expect(wb).toMatch(/<ChatSidebar onClose=/);
  });

  it("④ 侧栏头上的「收起」排在新会话之前（关的入口不该比新建更靠里）", () => {
    const collapseAt = chat.indexOf('data-testid="wb-chat-collapse"');
    const newAt = chat.indexOf('title="新会话"');
    expect(collapseAt).toBeGreaterThan(-1);
    expect(newAt).toBeGreaterThan(collapseAt);
  });
});
