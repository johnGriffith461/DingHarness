import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ESC_YIELDS_SELECTORS, escYieldsToOverlay } from "./escOverlays";

/**
 * 工作台这一片的**接线守卫**（2026-10-16 审计 P107 / P108 / P09 / P46 / P48）。
 *
 * 行为判据在专门的文件里（`concurrentTurns` / `resolveOnce`）；这一份盯"有没有接上"：
 * 浮层名单、设置页的 Esc、许可开关的未知态、发送键与提交路径的守卫。
 */

const ROOT = path.resolve(__dirname, "..", "..");
/** 去掉注释（免得注释里写的旧写法/理由把守卫自己骗了）。 */
function source(rel: string): string {
  const text = readFileSync(path.join(ROOT, rel), "utf8");
  return text.replace(/\{\/\*[\s\S]*?\*\/\}/g, "").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

describe("P107：Esc 的「浮层让路」名单", () => {
  it("⭐ 名单里必须有那四类浮层（只认 `.wb-modal-mask` 就会两头一起关）", () => {
    for (const sel of [".wb-cmd-panel", ".wb-ctx", ".wb-acct-menu", ".cv-ctx"]) {
      expect(ESC_YIELDS_SELECTORS, `${sel} 不在让路名单里 —— 开着它按 Esc 会把右侧面板也一起收掉`).toContain(sel);
    }
  });

  it("判定：任一个浮层在就返回 true；都不在才返回 false", () => {
    expect(escYieldsToOverlay((sel) => sel === ".cv-ctx")).toBe(true);
    expect(escYieldsToOverlay((sel) => sel === ".wb-acct-menu")).toBe(true);
    expect(escYieldsToOverlay(() => false)).toBe(false);
  });

  it("⭐ Workbench 的 Esc 处理走的是这份名单（而不是自己再写一个选择器）", () => {
    const wb = source("src/workbench/Workbench.tsx");
    expect(wb, "又变回只认一个 `.wb-modal-mask` 了（P107）").toContain("escYieldsToOverlay(");
    expect(/document\.querySelector\("\.wb-modal-mask"\)/.test(wb), "自己又手写了一个 querySelector").toBe(false);
  });
});

describe("P108：设置弹窗真的处理 Esc", () => {
  const dialog = source("src/workbench/SettingsDialog.tsx");

  it("⭐ 弹窗里有 keydown/Escape 处理（注释与守卫原来在说、代码里没有）", () => {
    expect(dialog, "`grep keydown/Escape` 命中 0 行就是 P108 的形状").toMatch(/addEventListener\(\s*"keydown"/);
    expect(dialog).toMatch(/e\.key !== "Escape"/);
  });

  it("无障碍语义：整页浮层要如实标成对话框", () => {
    expect(dialog, "缺 role=dialog —— 读屏不知道这里进了一层").toContain('role="dialog"');
    expect(dialog).toContain('aria-modal="true"');
  });

  it("设置页要进「让路名单」（它自己处理 Esc，别把背后的面板也收掉）", () => {
    expect(ESC_YIELDS_SELECTORS).toContain(".wb-setfull");
  });
});

describe("P09：许可开关的状态未知要说实话", () => {
  const phone = source("src/workbench/PhonePage.tsx");

  it("⭐ 初值不是写死的 true（那是「许可」：未知就显示「允许连接」等于替用户答应）", () => {
    expect(
      /useState\(true\)/.test(phone),
      "又写死成 true 了 —— 读状态之前界面就在承诺「允许连接」",
    ).toBe(false);
    expect(phone, "未知态要有自己的表示").toContain("useState<boolean | null>(null)");
  });

  it("⭐ `status()` 要 catch（读失败时不能把写死的 true 留在界面上）", () => {
    const block = phone.slice(phone.indexOf("bridge.remote"), phone.indexOf("toggleConnect"));
    expect(block, "没有 catch：读失败与「允许连接」在界面上长得一模一样").toContain(".catch(");
  });

  it("切换以主进程返回值为准（与 keepAwake 同一套口径）", () => {
    const toggle = phone.slice(phone.indexOf("const toggleConnect"), phone.indexOf("const toggleAwake"));
    expect(toggle, "只看本地意图、不看主进程回了什么").toContain("setAllowConnect(actual)");
  });
});

describe("P46：界面侧与 store 侧各有一道「跑着就不许再发」", () => {
  const composer = source("src/workbench/Composer.tsx");
  const store = source("src/workbench/store.ts");

  it("⭐ 输入区提交前要看 `running`，并**说一句**（不是静默吞掉）", () => {
    const submit = composer.slice(composer.indexOf("const submit = async"), composer.indexOf("const enabledNames"));
    expect(submit, "跑着的时候按 Enter 又能起第二轮了").toMatch(/if\s*\(\s*running\s*\)/);
    expect(submit, "要如实说一句（静默返回 = 用户以为按了没反应）").toContain("showMaterialNote(");
  });

  it("⭐ store 侧 `sendInTask` 也要拦（挡住绕过界面的路）", () => {
    const send = store.slice(store.indexOf("sendInTask: async"), store.indexOf("rewindTask: async"));
    expect(send, "同会话并发两轮的入口没有守卫").toContain("isSessionRunning(");
  });

  it("「停止」按会话停（打错对象就是这里）", () => {
    expect(composer, "停止没把当前会话传下去 —— 同会话并发两轮时停的是别人").toContain("abort(activeTask?.id)");
  });

  it("⭐ 提交键的忙碌文案是**导出常量**（与「此刻那颗键是停止」是同一件事的两种说法）", () => {
    expect(composer).toContain("export const P46_BUSY_NOTE");
  });
});

describe("P48：界面侧也各有防重复提交", () => {
  it("工具留痕的允许/拒绝：点下去就禁用并改成「执行中…」", () => {
    const list = source("src/workbench/ToolTraceList.tsx");
    expect(list).toContain("disabled={Boolean(busy[");
    expect(list).toContain("执行中…");
  });

  it("创建智能体：提交中禁用那颗键", () => {
    const panel = source("src/workbench/AgentCreatePanel.tsx");
    expect(panel, "又变成裸 onClick 了 —— 连点两下建两条智能体").toContain("disabled={starting}");
    expect(panel).toMatch(/if\s*\(\s*starting\s*\)\s*return/);
  });

  it("装插件：同一帧的第二次点击要被 ref 拦住", () => {
    const page = source("src/workbench/PluginsPage.tsx");
    expect(page, "只靠 state 拦不住同一帧的第二次点击").toContain("pluginBusyRef.current");
    expect(page).toContain("disabled={pluginBusy}");
  });
});

describe("P27/P28：节点编辑的落盘出口都接上了缓冲", () => {
  it("形状文字：onChange 记缓冲、卸载时 flush、回车用 IME 判据", () => {
    const shape = source("src/canvas/nodes/ShapeNode.tsx");
    expect(shape).toContain("createEditBuffer(");
    expect(shape, "blur / 回车 / 卸载三个出口必须都调 flush").toMatch(/buffer\.flush\(\)/);
    expect(shape, "回车提交没走 IME 判据 —— 中文输入法里选词的回车会把内容切碎").toContain("shouldCommitOnEnter(");
    expect(shape, "卸载时没 flush —— 滚出视野/关掉画布就把刚打的字丢了").toMatch(
      /\(\)\s*=>\s*\(\)\s*=>\s*\{[\s\S]{0,200}buffer\.flush\(\)/,
    );
  });

  it("HTML 源码：同样三个出口走同一份缓冲", () => {
    const html = source("src/canvas/nodes/HtmlNode.tsx");
    expect(html).toContain("createEditBuffer(");
    expect(html, "切到预览前要先 flush（否则预览的是旧内容）").toMatch(/togglePreview[\s\S]{0,400}buffer\.flush\(\)/);
    expect(html, "卸载时没 flush").toMatch(/\(\)\s*=>\s*\(\)\s*=>\s*\{[\s\S]{0,160}buffer\.flush\(\)/);
  });

  it("白板：抬笔后那 500ms 里卸载也要把笔迹交出去", () => {
    const board = source("src/canvas/nodes/WhiteboardNode.tsx");
    expect(board, "卸载只 clearTimeout 不交笔迹 —— 最后几笔直接丢（P28）").toMatch(
      /dirtyRef\.current\)\s*commitStrokes\(\)/,
    );
  });
});

describe("P25：右键菜单与图层面板的动作都有撤销点", () => {
  it("⭐ 节点右键菜单：每个动作前都 commitHistory（放在 `on()` 里，一处管全部）", () => {
    const menu = source("src/canvas/NodeContextMenu.tsx");
    expect(menu, "11 项动作一处历史都不打 —— 点错了除了重来没有退路").toMatch(
      /selectNodes\(\[nodeId\]\);[\s\S]{0,200}commitHistory\(\)/,
    );
  });

  it("⭐ 图层面板的锁定/隐藏也打撤销点", () => {
    const panel = source("src/canvas/LayerPanel.tsx");
    const lock = panel.slice(panel.indexOf("data-layer-lock"), panel.indexOf("data-layer-eye"));
    const eye = panel.slice(panel.indexOf("data-layer-eye"));
    expect(lock, "锁定没有撤销点").toContain("commitHistory()");
    expect(eye, "隐藏没有撤销点（卡片从画布上消失，Ctrl+Z 也救不回来）").toContain("commitHistory()");
  });
});
