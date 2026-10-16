import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ESC_YIELDS_SELECTORS, escYieldsToOverlay } from "./escOverlays";
import { claimSeq, isStale } from "./TitleBar";

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

/** 带注释读源码（有几条判据盯的就是**注释**本身，见 P193）。 */
function raw(rel: string): string {
  return readFileSync(path.join(ROOT, rel), "utf8");
}

describe("P192：左栏那颗开关必须带字，且与右栏同一形态", () => {
  const nav = source("src/workbench/NavCollapseButton.tsx");

  it("⭐ 按钮里有**看得见**的两个字（不是只有一枚图标靠 title 提示）", () => {
    /*
     * 右栏那颗（`wb-summary-collapse`）就是被主人当场问过「打开了然后怎么关呢」
     * 才改成带字的。左栏这颗更硬：收起之后它是**唯一的回程**。
     */
    expect(nav, "又变成一枚没字的图标了 —— 左栏收起后没人认得出这是回程").toMatch(
      /\{collapsed \? "展开" : "收起"\}/,
    );
  });

  it("与右栏共用同一条样式规则（两处形态不会再漂）", () => {
    expect(nav, "要挂上那颗开关的类").toContain('className="wb-nav-collapse"');
    const css = source("src/styles/ding-harness-shell.css");
    expect(
      css,
      "`.wb-nav-collapse` 没和 `.wb-summary-collapse` 写在同一条规则里 —— 形态开始各写一份了",
    ).toMatch(/\.wb-summary-collapse,\s*\.wb-nav-collapse\s*\{/);
  });

  it("可访问名与几何还在（收起/展开是两件事、按钮不许禁用）", () => {
    expect(nav).toMatch(/collapsed \? "展开左侧栏" : "收起左侧栏"/);
    expect(nav).not.toMatch(/disabled/);
    expect(nav).toContain('data-testid="wb-nav-collapse"');
  });
});

describe("P193：那颗按钮的页面清单要与实际引用点一致", () => {
  /** 渲染这颗按钮的页面 → 它在注释里的中文名（新页面接上来时必须一起补，见下面那条断言）。 */
  const PAGE_OF: Record<string, string> = {
    "PhonePage.tsx": "手机遥控电脑",
    "PluginsPage.tsx": "插件",
    "ScheduledPage.tsx": "定时任务",
    "ThreadListPage.tsx": "历史对话",
    "TaskView.tsx": "任务视图",
  };

  /** 真的渲染了这颗按钮的文件（`<NavCollapseButton />`，不是 import 行）。 */
  function users(): string[] {
    const dir = path.join(ROOT, "src", "workbench");
    return readdirSync(dir)
      .filter((name) => name.endsWith(".tsx") && name !== "NavCollapseButton.tsx")
      .filter((name) => /<NavCollapseButton\s*\/>/.test(source(`src/workbench/${name}`)))
      .sort();
  }

  it("⭐ 注释里不许再声称「任务中心」有它（它从来没有，假清单还盖住了真实缺口）", () => {
    const store = raw("src/workbench/store.ts");
    const doc = store.slice(store.indexOf("左侧导航栏是否收起"), store.indexOf("navCollapsed: boolean;"));
    expect(doc, "找不到那段注释（判据锚不住了，改锚点前先想清楚）").not.toBe("");
    /*
     * 提可以提（"它没有"本身就是有用的信息），但**每一条提到它的行都要写明它没有** ——
     * 这正是 P193 的判据：清单与实现两边口径一致。
     * 旧那句「…外加任务中心的头部」自成一行的写法在这一条下必红。
     */
    for (const line of doc.split("\n").filter((l) => l.includes("任务中心"))) {
      expect(line, `这一行把任务中心当成"有这颗按钮"的地方了：${line.trim()}`).toMatch(/没有|从来没有/);
    }
  });

  it("⭐ 注释点到的页面 = 真的用了这颗按钮的页面（两边对账）", () => {
    const store = raw("src/workbench/store.ts");
    const doc = store.slice(store.indexOf("左侧导航栏是否收起"), store.indexOf("navCollapsed: boolean;"));
    const actual = users();
    expect(actual.length, "一个引用点都没有？扫描判据坏了").toBeGreaterThan(0);
    for (const file of actual) {
      const page = PAGE_OF[file];
      expect(
        page,
        `${file} 也挂上了这颗按钮 —— 请把它的名字补进 PAGE_OF 与 store.ts 的清单（P193 的形状就是清单漂了）`,
      ).toBeTruthy();
      expect(doc, `store.ts 的清单里没提「${page}」（实际引用点 ${file}）`).toContain(page as string);
    }
    /* 反向：清单里列着的页面必须真的还在用它 */
    for (const [file, page] of Object.entries(PAGE_OF)) {
      if (!actual.includes(file)) {
        expect(doc, `清单里的「${page}」已经不用这颗按钮了，注释该跟着改`).not.toContain(page);
      }
    }
  });
});

describe("P187 / P191：收起态跨重启记得住（设置 ↔ 界面状态只有一条接线）", () => {
  const nav = source("src/workbench/NavSidebar.tsx");

  it("⭐ 三个端口都真的绑在 store 与设置上（缺一条这条线就是断的）", () => {
    expect(nav, "接线没了 —— 收起态又只活在内存里").toContain("startNavCollapsedSync(");
    expect(nav, "读的是设置里那份缓存（`load()` 填好的）").toContain("read: navCollapsedNow");
    expect(nav, "灌进界面状态（否则「记住」了也不会显示）").toMatch(
      /apply: \(saved\) => useWorkbenchStore\.setState\(\{ navCollapsed: saved \}\)/,
    );
    expect(nav, "界面一变就要写回去").toContain("state.navCollapsed !== prev.navCollapsed");
    expect(nav).toContain("onChange(state.navCollapsed)");
  });

  it("⭐ 载入那一步在（不 `load()` 的话盘上那份永远灌不进来）", () => {
    expect(source("src/workbench/Workbench.tsx"), "没人读设置 —— 重启回来还是展开的").toContain(
      "useAppSettings.getState().load()",
    );
  });

  it("⭐ 落盘字段在契约与设置里都有（否则写出去的是空对象）", () => {
    expect(raw("shared/ipc.ts"), "契约里缺 navCollapsed：`write` 传不上去").toContain("navCollapsed");
    const settings = source("src/workbench/appSettings.ts");
    expect(settings).toContain("setNavCollapsed");
    expect(settings, "写的是**整份**设置（只送自己那一项会把钉住的模型抹掉）").toContain(
      "pinnedModel: get().pinnedModel",
    );
  });

  it("⭐ store 里不许自己也接一遍（两条接线会互相覆盖，也重复写盘）", () => {
    const store = source("src/workbench/store.ts");
    expect(store, "store.ts 又自己去读写设置了 —— 接线只许有一处").not.toContain("appSettings");
  });
});

describe("P194：最大化状态只认一条真源（过期回包不许覆盖新状态）", () => {
  const bar = source("src/workbench/TitleBar.tsx");

  it("⭐ 序号判据本身：领了新号，旧号就地作废", () => {
    const box = { next: 0 };
    const first = claimSeq(box);
    expect(isStale(box, first), "刚领的号不该是过期的").toBe(false);
    const second = claimSeq(box);
    expect(isStale(box, first), "领了新号之后旧号必须作废（旧回包不许落地）").toBe(true);
    expect(isStale(box, second)).toBe(false);
  });

  it("⭐ 连点两下：先发的回包后到时不许把图标按回去", () => {
    /*
     * 这就是 P194 的实例：主进程那两趟 IPC 的回包顺序与推送顺序都不保证，
     * 而旧的写法是 `.then(setMaximized)` —— 谁后到谁写，**不看谁更新**。
     */
    const box = { next: 0 };
    const click1 = claimSeq(box); // 第一次点击
    const click2 = claimSeq(box); // 第二次点击（更晚）
    expect(isStale(box, click1), "第一次的回包现在过期了").toBe(true);
    expect(isStale(box, click2), "第二次的回包才作数").toBe(false);
  });

  it("⭐ 源码：三处写入都过序号，不许再有裸的 `setMaximized`", () => {
    /* 推送那一路是真源：它到的时候要就地作废所有在飞的查询（`claimSeq` 紧跟 `setMaximized`） */
    expect(bar, "主进程推来的 `maximizedChanged` 是真源，不能被回包盖住").toMatch(
      /onMaximizedChange\(\(v\) => \{\s*claimSeq\(/,
    );
    /* 初始查询与点击回包都要先领号、落地前比一次 */
    expect(bar, "初始查询也要领号（推送先到就该作废它）").toContain("claimSeq(seqRef.current)");
    expect(bar).toContain("isStale(seqRef.current, seq)");
    /*
     * 逐行扫：每一处 `setMaximized(` 的前三行里必须出现过 `isStale(` 或 `claimSeq(`。
     * 这比"数一数字符串"准 —— 它盯的正是"这次写入有没有比过谁最新"。
     */
    const lines = bar.split("\n");
    const unguarded: string[] = [];
    lines.forEach((line, index) => {
      if (!line.includes("setMaximized(")) return;
      const context = lines.slice(Math.max(0, index - 3), index + 1).join("\n");
      if (!/isStale\(|claimSeq\(/.test(context)) unguarded.push(`第 ${index + 1} 行 ${line.trim()}`);
    });
    expect(unguarded, "这些写入没有比过序号 —— 旧回包会把图标按回反状态（P194）").toEqual([]);
    expect(bar, "点击那颗键要走 `toggleMaximized`（回包只当乐观更新）").toContain("onClick={toggleMaximized}");
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
