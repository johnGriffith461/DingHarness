import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * 窗口外壳守卫（2026-10-15，M0 工单 1）。
 *
 * ## 它挡的是什么
 *
 * 用户报的缺陷是「窗口右上角关闭/最小化按钮**重复显示**」。查清之后根因不是"多画了一套"，
 * 而是：Windows 的 `titleBarOverlay` 在右上角**固定**画了一套原生 caption 按钮
 * （约 138×36 DIP），而「云盘 / 插件·技能·伙伴 / 定时任务」三个视图**自己的操作按钮
 * 就在同一个角上**（实测 `wb-cloud-new` 等都在 x=1359..1426，视口 1440）——
 * 两簇按钮叠在一起，应用自己的按钮被压掉半个字。
 * OS 层实拍：`.verify/m0/repro-cloud-topright.png`；修后：`.verify/m0/v2-cloud-top.png`。
 *
 * 修法是把原生覆盖层**整条删掉**、窗口按钮改由应用自绘（`src/workbench/TitleBar.tsx`
 * → `electron/ipc/windowControls.ts`），并让 `.wb` 用 `padding-top` 让出标题栏那一条。
 * 这一条**不是排版口味**：标题栏同时是窗口的拖动区，而拖动区会吃掉落在它底下的点击 ——
 * 让出来，它就永远压在空处。
 *
 * ## 为什么是"读源码"式守卫
 *
 * 这几条挡的是**写法**（加回一个窗口选项、把高度抄成两个数、把拖动区挪到别处），
 * 行为由 `scripts/accept/accept-windowctl.mjs` 真点界面来挡（那一条还会用真实鼠标输入
 * 拖一次窗口、点最大化和最小化、并断言"标题栏底下没有可点元素"）。
 * 与 `uiCraft.test.ts` 同一个套路：**这两层缺一层都拦不住复发**。
 */

const ROOT = path.resolve(__dirname, "..");
const STYLE_DIR = path.join(ROOT, "src", "styles");

/** 读一个文件并**去掉注释** —— 否则我自己写在注释里的解释会被当成违规（C1/C2 踩过这个坑）。 */
function readCode(rel: string): string {
  const raw = readFileSync(path.join(ROOT, rel), "utf8");
  return raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

/** 样式文件（含入口）拼起来，同样去注释。 */
function allCss(): string {
  const files = ["styles.css", ...readdirSync(STYLE_DIR).filter((f) => f.endsWith(".css")).map((f) => `styles/${f}`)];
  return files.map((f) => readCode(`src/${f}`)).join("\n");
}

/** 取某个选择器的规则体（取**最后一处**同名规则：覆盖块追加在文件末尾）。 */
function ruleBody(css: string, selector: string): string {
  const at = css.lastIndexOf(`${selector} {`);
  if (at < 0) return "";
  return css.slice(at, css.indexOf("}", at) + 1);
}

describe("窗口外壳守卫（M0 工单 1：右上角按钮重复显示）", () => {
  const mainTs = readCode("electron/main.ts");
  const css = allCss();

  it("① 不许把 titleBarOverlay 加回来（它就是固定在右上角的那一套）", () => {
    expect(mainTs).not.toMatch(/titleBarOverlay/);
    expect(mainTs).not.toMatch(/setTitleBarOverlay/);
  });

  it("② 「给覆盖层改配色」那条死通路不许复活", () => {
    /*
     * 覆盖层删了之后，`setTitlebar` 这条 IPC 就没有接收方了。
     * 留着它的表现是"渲染层调了一个不存在的通道" —— 不报错、也没效果，
     * 正是 C4 当年揪出来的那类漂移。三处（契约 / preload / 主题）都必须干净。
     */
    for (const rel of ["shared/ipc.ts", "electron/preload.ts", "src/workbench/theme.ts", "electron/main.ts"]) {
      expect(readCode(rel), `${rel} 里还有 setTitlebar`).not.toMatch(/setTitlebar|app:titlebar/);
    }
  });

  it("③ 全仓只有一处拖动区，且它挂在标题栏上", () => {
    const dragRules = css.match(/-webkit-app-region:\s*drag/g) ?? [];
    expect(dragRules.length, "拖动区只能有一处 —— 多一处就可能压在按钮上吞点击").toBe(1);
    expect(ruleBody(css, ".wb-titlebar")).toMatch(/-webkit-app-region:\s*drag/);
    /* 标题栏里的按钮必须自己 no-drag，否则点不动 */
    expect(ruleBody(css, ".wb-winctl")).toMatch(/-webkit-app-region:\s*no-drag/);
  });

  it("④ 标题栏高度只有一处定义，`.wb` 让出的就是它", () => {
    const declared = css.match(/--win-titlebar-h:\s*([0-9.]+)px/);
    expect(declared, "`--win-titlebar-h` 没有声明").toBeTruthy();
    expect(ruleBody(css, ".wb-titlebar")).toMatch(/height:\s*var\(--win-titlebar-h\)/);
    /*
     * 让出这一条是**功能性的**（别让拖动区吞掉内容层的点击），
     * 抄成两个数就会漂：改了一处、另一处还留着旧值，于是要么压住 1px 按钮、要么留一条缝。
     */
    expect(ruleBody(css, ".wb"), "`.wb` 必须用同一个变量让出标题栏那一条").toMatch(
      /padding-top:\s*var\(--win-titlebar-h\)/,
    );
  });

  it("⑤ 标题栏必须 border-box，且底下不留缝", () => {
    /*
     * 仓库里**没有**全局 `box-sizing: border-box`。标题栏有 1px 底边，
     * content-box 下它会被撑成 37px 而 `.wb` 只让出 36px —— 正好压住内容 1px。
     */
    expect(ruleBody(css, ".wb-titlebar")).toMatch(/box-sizing:\s*border-box/);
  });

  it("⑥ 标题栏真的被渲染，并且是 `.wb` 的第一个孩子", () => {
    const wb = readCode("src/workbench/Workbench.tsx");
    const app = readCode("src/App.tsx");
    expect(app, "入口渲染的必须是工作台外壳").toMatch(/<Workbench\s*\/>/);
    const at = wb.search(/<TitleBar\s*\/>/);
    expect(at, "Workbench 里没有渲染 <TitleBar />").toBeGreaterThan(-1);
    /* 拖动区必须是第一个孩子：排在后面就可能被别的兄弟节点盖住（z-index 之外还有层叠上下文） */
    expect(wb.indexOf("<NavSidebar")).toBeGreaterThan(at);
    /* 那个 class 名是守卫 ③④⑤ 的锚点：组件没挂上它，上面几条就都在查一个不存在的规则 */
    expect(readCode("src/workbench/TitleBar.tsx")).toContain('className="wb-titlebar"');
  });
});
