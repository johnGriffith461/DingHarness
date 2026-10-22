import { app, webContents as electronWebContents, type WebContents } from "electron";
import fs from "node:fs";
import path from "node:path";


import { previewableUrl } from "../../shared/preview";
import { markUntrusted } from "../../shared/untrusted";
import { NOT_ATTACHED_NOTICE as NOT_ATTACHED, isAttachable } from "../../shared/browserAttach";
import { blockedReason } from "../../shared/browserUrl";
import { renderSnapshot as renderAxSnapshot, clearRefs, type AxNode, type SnapshotRef } from "../../engine/runtime/browserSnapshot";
import { parseKeyCombo } from "../../shared/keyCombo";

/**
 * **浏览器 agent 的宿主**（G04，2026-10-18）。
 *
 * ## 与预览窗口（`preview.ts`）的分工
 *
 * | | 预览 | agent 浏览器 |
 * |---|---|---|
 * | 谁操作 | 人 | 模型（经工具） |
 * | 分区 | `persist:preview` | `persist:agent-browser` |
 * | 能力 | 打开/导航 | 快照/点击/输入/滚动/截图 |
 * | 地址策略 | 只本机 | 默认本机；外网需**显式放行** |
 *
 * 两者**不共用一个窗口**：预览是"用户在看"，agent 是"模型在操作" ——
 * 混在一起会让"我明明在看这个页，它怎么跳走了"变成常态。
 *
 * ## 安全边界（不装）
 *
 * - 默认只允许本机地址（与预览同一条策略 `previewableUrl`）；
 * - 外网地址只有调用方**确认放行**（权限规则命中 allow）才打开 —— 这一层在工具执行体里判；
 * - 页面文字进上下文前标 `[untrusted]`（G19）；
 * - 无 preload、`nodeIntegration:false`、`contextIsolation:true`、`sandbox:true`；
 * - 新窗口一律 deny（要开新页就在同一窗口里导航）。
 *
 * ## 一个如实说明
 *
 * 快照是"注入脚本读 DOM"，不是完整的 Accessibility 树 —— 好处是 ref 能直接点回去，
 * 坏处是**跨 iframe 的内容看不到**（同源 iframe 也没做）。跨域 iframe 本来就不可控，
 * 这里如实写在快照结果里，不让模型以为"页面上只有这些"。
 */

/** 一个可交互元素（快照里给模型看的形状）。 */
export type BrowserElement = {
  ref: string;
  role: string;
  name: string;
  x: number;
  y: number;
  w: number;
  h: number;
};

/** 一次快照。 */
export type BrowserSnapshot = {
  url: string;
  title: string;
  elements: BrowserElement[];
  text: string;
  truncated: { elements: boolean; nodes: boolean };
  /** 页面里有几个 iframe（跨域内容看不到，如实说）。 */
  iframes: number;
};

/** 浏览器动作的结果。 */
export type BrowserResult<T> = { ok: true; value: T } | { ok: false; error: string };

/**
 * **单例宿主 = 右栏那个 `<webview>` 的 webContents**（B-01，2026-10-22）。
 *
 * 之前这里是 `new BrowserWindow()` —— 一个独立窗口「Ding · 浏览器」。
 * 于是"用户看的"（右栏 webview）与"模型操作的"（这个窗口）是**两个浏览器**：
 * 两套 cookie、两个页面，agent 读不到用户正在看的那一页。
 *
 * 现在只剩一个：面板把自己的 webContentsId 报上来（`browser:attach`），
 * 所有动作都打到**同一个** webContents。
 */
let agentContents: WebContents | null = null;

/**
 * 接上右栏的 `<webview>`。
 *
 * @param id `webview.getWebContentsId()`
 */
export function attachToWebContents(id: number): BrowserResult<{ id: number }> {
  if (!Number.isInteger(id) || id <= 0) return { ok: false, error: "webContentsId 不合法" };
  const contents = electronWebContents.fromId(id);
  if (!contents) return { ok: false, error: "找不到那个 webContents（面板可能已经关了）" };
  if (!isAttachable(contents.getType())) {
    return { ok: false, error: `只接受右栏浏览器的 webview（收到的是 ${contents.getType()}）` };
  }
  if (agentContents && !agentContents.isDestroyed() && agentContents.id !== contents.id) {
    /* 重复 attach：覆盖，旧的自动解绑（不额外做清理，它归面板管） */
    console.log(`[browser] 切换浏览器：${agentContents.id} → ${contents.id}`);
  }
  agentContents = contents;
  /* 关页/导航时模型那边的"当前页"自然跟着变；这里只做销毁清理 */
  contents.once("destroyed", () => {
    if (agentContents === contents) agentContents = null;
  });
  /*
   * B-05：导航与弹窗在这里收口（与地址策略同一处判定）。
   * 之前只有独立窗口自己设过 deny；接上 webview 之后必须在这里补。
   */
  contents.setWindowOpenHandler(() => ({ action: "deny" }));
  /*
   * B-05：**所有导航入口都过同一条策略** —— 点击链接、脚本跳转、重定向。
   * 之前只在 `browserOpen` 里判一次，页面里点一下就能绕过去。
   * 本机页面在这里是**放开**的（用户自己的测试站要能用；外网首次导航仍由
   * `browserOpen` 的 allowExternal 决定）。
   */
  const guard = (event: { preventDefault: () => void }, url: string): void => {
    const why = blockedReason(url, { allowLocal: true });
    if (!why) return;
    event.preventDefault();
    console.log(`[browser] 拦下一次导航：${why}（${url.slice(0, 120)}）`);
  };
  contents.on("will-navigate", (event, url) => guard(event, url));
  contents.on("will-redirect", (event, url) => guard(event, url));
  /* B-02：导航之后旧的 backendNodeId 全部失效 —— ref 从 e1 重新开始 */
  const resetRefs = (): void => {
    clearRefs(refRegistry);
    refToBackend.clear();
  };
  contents.on("did-navigate", resetRefs);
  contents.on("did-navigate-in-page", resetRefs);
  /* B-04：控制台与网络（只留最近 50 条；不记 header/body） */
  contents.on("console-message", (_e, level, message) => recordConsole(level, message));
  try {
    const filter = { urls: ["http://*/*", "https://*/*"] };
    contents.session.webRequest.onCompleted(filter, (details) => {
      recordNetwork(details.method, details.url, details.statusCode);
    });
  } catch {
    /* 某些 session 配置下 webRequest 不可用：如实降级（网络记录为空，不崩） */
  }
  const notify = (): void => {
    try {
      navigateListener?.({ url: contents.getURL(), title: contents.getTitle(), by: "agent" });
    } catch {
      /* 通知失败不影响导航本身 */
    }
  };
  contents.on("did-navigate", notify);
  contents.on("did-navigate-in-page", notify);
  contents.on("page-title-updated", notify);
  return { ok: true, value: { id: contents.id } };
}

/** 面板卸载 / 关页时解绑。 */
export function detachFromWebContents(id?: number): void {
  if (!agentContents) return;
  if (typeof id === "number" && agentContents.id !== id) return;
  agentContents = null;
}

/**
 * **ref 的稳定来源**（B-02）：`backendDOMNodeId → eN`。
 *
 * 挂在模块级（不是每次快照新建）：同一个 DOM 节点在连续快照里复用同一个 ref，
 * 页面局部刷新不会让别的元素换号。导航时清空（旧 id 在新页面上没有意义）。
 */
const refRegistry = new Map<number, string>();
/** 反查：ref → backendNodeId（click/type 用）。 */
const refToBackend = new Map<string, number>();

/** CDP 的报错常常是 `{ code, message }`，给模型看的要是一句话。 */
function describeCdpError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/Debugger is not attached|not attached/i.test(message)) {
    return "调试通道没接上（页面可能刚导航）—— 重新取一次快照";
  }
  if (/Cannot find context|Object reference chain/i.test(message)) {
    return "页面已经变了（这个元素不在了）—— 重新取一次快照";
  }
  if (/another debugger|DevTools/i.test(message)) {
    return "开发者工具正开着，调试通道被占用 —— 先关掉开发者工具再试";
  }
  return message.slice(0, 200);
}

/** 接上 CDP（已经附着就直接复用；DevTools 打开时会失败，交给调用方出人话）。 */
async function ensureDebugger(contents: import("electron").WebContents) {
  if (!contents.debugger.isAttached()) {
    contents.debugger.attach("1.3");
    /*
     * 两个 domain 都要显式开：`Accessibility` 不开时 `getFullAXTree` 可能返回空，
     * `DOM` 不开时 `resolveNode` / `getBoxModel` 拿不到对象。
     */
    await contents.debugger.sendCommand("Accessibility.enable");
    await contents.debugger.sendCommand("DOM.enable");
    await contents.debugger.sendCommand("Page.enable");
  }
  return contents.debugger;
}

/** 把 ref 解析成 `{contents, backendNodeId}`（B-03 的 hover/select 共用）。 */
function refBackend(
  ref: string,
): { contents: import("electron").WebContents; backendNodeId: number } | { error: string } {
  const contents = live();
  if (!contents) return { error: NOT_ATTACHED };
  const backendNodeId = refToBackend.get(String(ref ?? "").trim());
  if (!backendNodeId) {
    return { error: `快照里没有这个 ref：${ref} —— 重新取一次 browser_snapshot（页面可能已变）` };
  }
  return { contents, backendNodeId };
}

/** 元素中心点（B-03：click/hover 共用同一套量法）。 */
async function centerOf(
  dbg: import("electron").Debugger,
  backendNodeId: number,
): Promise<{ x: number; y: number } | { error: string }> {
  const resolved = (await dbg.sendCommand("DOM.resolveNode", { backendNodeId })) as { object?: { objectId?: string } };
  const objectId = resolved.object?.objectId;
  if (!objectId) return { error: "这个元素已经不在页面上了 —— 重新取一次快照" };
  await dbg.sendCommand("Runtime.callFunctionOn", {
    objectId,
    functionDeclaration: "function(){this.scrollIntoView({block:'center',inline:'center'});}",
  });
  const box = (await dbg.sendCommand("DOM.getBoxModel", { objectId })) as { model?: { content?: number[] } };
  const q = box.model?.content;
  if (!q || q.length < 8) return { error: "量不到这个元素的位置（它可能不可见）" };
  return { x: (q[0] + q[2] + q[4] + q[6]) / 4, y: (q[1] + q[3] + q[5] + q[7]) / 4 };
}

/**
 * 导航通知（B-06）：agent 或用户让页面跳转时，告诉宿主"现在在哪一页"。
 *
 * 宿主（主进程）把它推给渲染层的地址栏；面板因此**跟 agent 走同一个页面**。
 * 没有订阅者时什么也不做（CLI / 测试）。
 */
type NavigateInfo = { url: string; title: string; by: "agent" | "user" };
let navigateListener: ((info: NavigateInfo) => void) | null = null;

/** 注册导航通知（桌面宿主在注册 IPC 时调一次）。 */
export function setBrowserNavigateListener(fn: ((info: NavigateInfo) => void) | null): void {
  navigateListener = fn;
}

/* ── B-04：最近的控制台与网络记录（给模型 debug 用，只留 50 条） ── */

export type ConsoleEntry = { level: "log" | "warn" | "error" | "info"; text: string };
export type NetworkEntry = { method: string; url: string; status: number };

const consoleLog: ConsoleEntry[] = [];
const networkLog: NetworkEntry[] = [];
/** 最近一次快照的文本（`browser_find` 在它里面搜，省一次完整快照的 token）。 */
let lastSnapshotText = "";

/** 记录控制台（`console-message` 事件挂上时调）。 */
export function recordConsole(level: number, message: string): void {
  const names = ["log", "warn", "error", "info"] as const;
  consoleLog.push({ level: names[level] ?? "log", text: String(message).slice(0, 500) });
  if (consoleLog.length > 50) consoleLog.shift();
}

/** 记录一次网络请求（只记 method/url/status，**不记 header 与 body** —— 那会带出 token）。 */
export function recordNetwork(method: string, url: string, status: number): void {
  networkLog.push({ method: method.toUpperCase(), url: String(url).slice(0, 300), status });
  if (networkLog.length > 50) networkLog.shift();
}

/** 最近 50 条控制台。 */
export function browserConsole(): BrowserResult<{ entries: ConsoleEntry[] }> {
  const contents = live();
  if (!contents) return { ok: false, error: NOT_ATTACHED };
  return { ok: true, value: { entries: [...consoleLog] } };
}

/** 最近 50 条网络请求。 */
export function browserNetwork(): BrowserResult<{ entries: NetworkEntry[] }> {
  const contents = live();
  if (!contents) return { ok: false, error: NOT_ATTACHED };
  return { ok: true, value: { entries: [...networkLog] } };
}

/**
 * 在**最近一次快照**里搜文字，返回命中的 ref 行（B-04）。
 *
 * 为什么要有它：快照可能上万字符，模型只想找"登录"按钮时，
 * 让它再取一次全量快照既慢又费 token。
 */
export function browserFind(text: string): BrowserResult<{ hits: string[] }> {
  const needle = String(text ?? "").trim();
  if (!needle) return { ok: false, error: "要搜什么？给 text" };
  if (!lastSnapshotText) return { ok: false, error: "还没有快照 —— 先 browser_snapshot" };
  const hits = lastSnapshotText
    .split(String.fromCharCode(10))
    .slice(0, 30);
  return { ok: true, value: { hits } };
}

/** 截图落盘目录（`<userData>/browser-shots`）。 */
function shotsDir(): string {
  return path.join(app.getPath("userData"), "browser-shots");
}

/** 当前页（没有就是 null —— 调用方给"先打开右栏浏览器"的人话）。 */
function live(): WebContents | null {
  return agentContents && !agentContents.isDestroyed() ? agentContents : null;
}



/**
 * 打开一个地址。
 *
 * @param raw 地址
 * @param opts.allowExternal 外网地址是否已放行
 */
export async function browserOpen(
  raw: string,
  opts: { allowExternal: boolean },
): Promise<BrowserResult<{ url: string; title: string }>> {
  const local = previewableUrl(raw);
  let target = local;
  if (!target) {
    /* 外网地址：只有明确放行才继续；否则给出可读原因（并说明怎么放行） */
    if (!opts.allowExternal) {
      return {
        ok: false,
        error:
          "这个地址不是本机的 —— 外网地址要先放行（在审批卡片上点「总是允许」，或在设置里加一条 browser_open 的 allow 规则）",
      };
    }
    const why = blockedReason(String(raw ?? ""), { allowLocal: false });
    if (why) return { ok: false, error: why };
    try {
      target = new URL(String(raw ?? "").trim());
    } catch {
      return { ok: false, error: "这个地址解析不了（检查一下写法）" };
    }
  }
  const contents = live();
  if (!contents) return { ok: false, error: NOT_ATTACHED };
  try {
    await contents.loadURL(target.toString());
  } catch (error) {
    return { ok: false, error: `打不开：${error instanceof Error ? error.message : String(error)}` };
  }
  return { ok: true, value: { url: contents.getURL(), title: contents.getTitle() } };
}

/**
 * 取快照：**CDP 的 Accessibility 树**（B-02，2026-10-22）。
 *
 * 旧做法是"注入脚本枚举固定 CSS 选择器 + 每次从 1 重排 `data-dsh-ref`"，
 * 页面一重渲染 ref 就可能指错元素，而且 iframe 内容完全看不到。
 * 现在：
 * - `Page.getFrameTree` 拿到全部 frame，每个 frame 各取一次 `Accessibility.getFullAXTree`；
 * - 渲染交给 `engine/runtime/browserSnapshot.ts`（纯函数、9 条单测）；
 * - ref 绑在 `backendDOMNodeId` 上（`refRegistry`），`did-navigate` 时清空。
 *
 * @param opts.maxChars 文本上限（默认 12k）
 */
export async function browserSnapshot(opts: { maxChars?: number } = {}): Promise<
  BrowserResult<{ url: string; title: string; text: string; refs: SnapshotRef[]; total: number; truncated: boolean }>
> {
  const contents = live();
  if (!contents) return { ok: false, error: NOT_ATTACHED };
  try {
    const dbg = await ensureDebugger(contents);
    const tree = (await dbg.sendCommand("Page.getFrameTree")) as {
      frameTree?: { frame?: { id?: string }; childFrames?: Array<{ frame?: { id?: string } }> };
    };
    /* 主 frame + 一层子 frame（再深的用 flatten 递归展开） */
    const frameIds: string[] = [];
    const walkFrames = (node: { frame?: { id?: string }; childFrames?: unknown[] } | undefined): void => {
      const id = node?.frame?.id;
      if (id) frameIds.push(id);
      for (const child of (node?.childFrames ?? []) as Array<{ frame?: { id?: string }; childFrames?: unknown[] }>) {
        walkFrames(child);
      }
    };
    walkFrames(tree.frameTree);

    const texts: string[] = [];
    const allRefs: SnapshotRef[] = [];
    let total = 0;
    let truncated = false;
    for (let i = 0; i < frameIds.length; i += 1) {
      const frameId = frameIds[i];
      if (!frameId) continue;
      const got = (await dbg.sendCommand("Accessibility.getFullAXTree", { frameId })) as { nodes?: AxNode[] };
      const rendered = renderAxSnapshot(got.nodes ?? [], refRegistry, {
        framePrefix: i === 0 ? "" : `f${i}`,
        ...(opts.maxChars === undefined ? {} : { maxChars: opts.maxChars }),
      });
      for (const r of rendered.refs) refToBackend.set(r.ref, r.backendNodeId);
      texts.push(rendered.text);
      allRefs.push(...rendered.refs);
      total += rendered.total;
      truncated = truncated || rendered.truncated;
    }
    lastSnapshotText = texts.join(String.fromCharCode(10, 10));
    return {
      ok: true,
      value: {
        url: contents.getURL(),
        title: contents.getTitle(),
        text: lastSnapshotText,
        refs: allRefs,
        total,
        truncated,
      },
    };
  } catch (error) {
    return { ok: false, error: `取快照失败：${describeCdpError(error)}` };
  }
}

/**
 * 点一个 ref（B-02：ref → backendNodeId → 真实鼠标事件）。
 *
 * 比"在页面里 `el.click()`"更接近真人：先滚到中间、按真实坐标按下抬起。
 * 也让"点完页面跳转"这种副作用与用户点一次的行为一致。
 */
export async function browserClick(ref: string): Promise<BrowserResult<{ name: string }>> {
  const contents = live();
  if (!contents) return { ok: false, error: NOT_ATTACHED };
  const backend = refToBackend.get(ref.trim());
  if (!backend) {
    return { ok: false, error: `快照里没有这个 ref：${ref} —— 重新取一次 browser_snapshot（页面可能已变）` };
  }
  try {
    const dbg = await ensureDebugger(contents);
    const resolved = (await dbg.sendCommand("DOM.resolveNode", { backendNodeId: backend })) as {
      object?: { objectId?: string };
    };
    const objectId = resolved.object?.objectId;
    if (!objectId) return { ok: false, error: "这个元素已经不在页面上了 —— 重新取一次快照" };
    await dbg.sendCommand("Runtime.callFunctionOn", {
      objectId,
      functionDeclaration: "function(){this.scrollIntoView({block:'center',inline:'center'});}",
    });
    const box = (await dbg.sendCommand("DOM.getBoxModel", { objectId })) as {
      model?: { content?: number[] };
    };
    const q = box.model?.content;
    if (!q || q.length < 8) return { ok: false, error: "量不到这个元素的位置（它可能不可见）" };
    const x = (q[0] + q[2] + q[4] + q[6]) / 4;
    const y = (q[1] + q[3] + q[5] + q[7]) / 4;
    for (const type of ["mousePressed", "mouseReleased"]) {
      await dbg.sendCommand("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1 });
    }
    return { ok: true, value: { name: ref } };
  } catch (error) {
    return { ok: false, error: `点击失败：${describeCdpError(error)}` };
  }
}

/**
 * 往 ref 指向的输入框里输入（B-02：ref → backendNodeId → 聚焦 → insertText）。
 */
export async function browserType(
  ref: string,
  text: string,
  submit = false,
): Promise<BrowserResult<{ chars: number }>> {
  const contents = live();
  if (!contents) return { ok: false, error: NOT_ATTACHED };
  const backend = refToBackend.get(ref.trim());
  if (!backend) {
    return { ok: false, error: `快照里没有这个 ref：${ref} —— 重新取一次 browser_snapshot` };
  }
  try {
    const dbg = await ensureDebugger(contents);
    const resolved = (await dbg.sendCommand("DOM.resolveNode", { backendNodeId: backend })) as {
      object?: { objectId?: string };
    };
    const objectId = resolved.object?.objectId;
    if (!objectId) return { ok: false, error: "这个元素已经不在页面上了 —— 重新取一次快照" };
    const focused = (await dbg.sendCommand("Runtime.callFunctionOn", {
      objectId,
      functionDeclaration:
        "function(){ this.focus(); if (typeof this.select === 'function') this.select(); return document.activeElement === this; }",
      returnByValue: true,
    })) as { result?: { value?: unknown } };
    if (focused.result?.value !== true) {
      return { ok: false, error: `${ref} 不是可聚焦的输入框（重新取一次快照看看它的 role）` };
    }
    await dbg.sendCommand("Input.insertText", { text });
    if (submit) {
      for (const type of ["keyDown", "keyUp"]) {
        await dbg.sendCommand("Input.dispatchKeyEvent", {
          type,
          key: "Enter",
          code: "Enter",
          windowsVirtualKeyCode: 13,
          nativeVirtualKeyCode: 13,
        });
      }
    }
    return { ok: true, value: { chars: text.length } };
  } catch (error) {
    return { ok: false, error: `输入失败：${describeCdpError(error)}` };
  }
}

/**
 * 悬停（B-03）：ref → 中心 → `Input.dispatchMouseEvent(type:"mouseMoved")`。
 */
export async function browserHover(ref: string): Promise<BrowserResult<{ name: string }>> {
  const target = refBackend(ref);
  if ("error" in target) return { ok: false, error: target.error };
  try {
    const dbg = await ensureDebugger(target.contents);
    const point = await centerOf(dbg, target.backendNodeId);
    if ("error" in point) return { ok: false, error: point.error };
    await dbg.sendCommand("Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y });
    return { ok: true, value: { name: ref } };
  } catch (error) {
    return { ok: false, error: `悬停失败：${describeCdpError(error)}` };
  }
}

/**
 * 按键（B-03）：支持 `Enter` / `Escape` / `Tab` 与 `Control+A`、`Shift+Tab` 这种组合。
 *
 * 组合键的解析放在 `shared/keyCombo.ts`（纯函数、有单测），这里只负责发事件。
 */
export async function browserPressKey(raw: string): Promise<BrowserResult<{ key: string }>> {
  const contents = live();
  if (!contents) return { ok: false, error: NOT_ATTACHED };
  const combo = parseKeyCombo(raw);
  if ("error" in combo) return { ok: false, error: combo.error };
  try {
    const dbg = await ensureDebugger(contents);
    const base = {
      key: combo.key,
      code: combo.code,
      windowsVirtualKeyCode: combo.keyCode,
      nativeVirtualKeyCode: combo.keyCode,
      modifiers: combo.modifiers,
    };
    await dbg.sendCommand("Input.dispatchKeyEvent", { type: "keyDown", ...base });
    await dbg.sendCommand("Input.dispatchKeyEvent", { type: "keyUp", ...base });
    return { ok: true, value: { key: raw.trim() } };
  } catch (error) {
    return { ok: false, error: `按键失败：${describeCdpError(error)}` };
  }
}

/**
 * 下拉选择（B-03）：在页面里设置 `<select>` 的值并派发 `change`。
 *
 * 为什么不用鼠标点开原生下拉：原生弹层不在 DOM 里，模型点不到；
 * 直接设值 + 派发事件与用户选一次的效果一致（React/Vue 都认 change）。
 */
export async function browserSelect(ref: string, values: string[]): Promise<BrowserResult<{ picked: string[] }>> {
  const target = refBackend(ref);
  if ("error" in target) return { ok: false, error: target.error };
  try {
    const dbg = await ensureDebugger(target.contents);
    const resolved = (await dbg.sendCommand("DOM.resolveNode", { backendNodeId: target.backendNodeId })) as {
      object?: { objectId?: string };
    };
    const objectId = resolved.object?.objectId;
    if (!objectId) return { ok: false, error: "这个元素已经不在页面上了 —— 重新取一次快照" };
    const got = (await dbg.sendCommand("Runtime.callFunctionOn", {
      objectId,
      functionDeclaration: `function(values){
        if (!(this instanceof HTMLSelectElement)) return { ok: false, reason: "not-select" };
        const wanted = new Set(values.map(String));
        let picked = 0;
        for (const opt of Array.from(this.options)) {
          const next = wanted.has(opt.value);
          if (opt.selected !== next) opt.selected = next;
          if (next) picked += 1;
        }
        if (!picked) return { ok: false, reason: "no-match" };
        this.dispatchEvent(new Event("input", { bubbles: true }));
        this.dispatchEvent(new Event("change", { bubbles: true }));
        return { ok: true, picked };
      }`,
      arguments: [{ value: values }],
      returnByValue: true,
    })) as { result?: { value?: { ok?: boolean; reason?: string; picked?: number } } };
    const value = got.result?.value;
    if (!value?.ok) {
      return {
        ok: false,
        error:
          value?.reason === "no-match"
            ? `下拉里没有这些值：${values.join(", ")}`
            : `${ref} 不是一个 <select>（重新取一次快照看看它的 role）`,
      };
    }
    return { ok: true, value: { picked: values } };
  } catch (error) {
    return { ok: false, error: `选择失败：${describeCdpError(error)}` };
  }
}

/** 后退 / 前进 / 刷新（B-03）。 */
export async function browserHistory(step: "back" | "forward" | "reload"): Promise<BrowserResult<{ url: string }>> {
  const contents = live();
  if (!contents) return { ok: false, error: NOT_ATTACHED };
  try {
    if (step === "reload") contents.reload();
    else {
      const history = contents.navigationHistory;
      if (step === "back") {
        if (!history.canGoBack()) return { ok: false, error: "没有上一页了（后退到底）" };
        history.goBack();
      } else {
        if (!history.canGoForward()) return { ok: false, error: "没有下一页了（前进到底）" };
        history.goForward();
      }
    }
    return { ok: true, value: { url: contents.getURL() } };
  } catch (error) {
    return { ok: false, error: `导航失败：${error instanceof Error ? error.message : String(error)}` };
  }
}

/**
 * 等页面出现某段文字（B-03）。
 *
 * 轮询 `document.body.innerText`：比"等固定秒数"可靠（慢网也能等到）。
 * 超时如实说没等到 —— 不假装成功。
 */
export async function browserWaitFor(opts: { text?: string; timeoutMs?: number }): Promise<BrowserResult<{ waitedMs: number }>> {
  const contents = live();
  if (!contents) return { ok: false, error: NOT_ATTACHED };
  const text = String(opts.text ?? "").trim();
  if (!text) return { ok: false, error: "要等什么？给 text" };
  const timeout = Math.min(30_000, Math.max(500, opts.timeoutMs ?? 8000));
  const started = Date.now();
  while (Date.now() - started < timeout) {
    try {
      const hit = (await contents.executeJavaScript(
        `document.body ? document.body.innerText.includes(${JSON.stringify(text)}) : false`,
        true,
      )) as boolean;
      if (hit) return { ok: true, value: { waitedMs: Date.now() - started } };
    } catch {
      /* 页面正在导航：继续等 */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return { ok: false, error: `等了 ${timeout}ms 页面上也没出现「${text}」` };
}

/**
 * 滚动当前页。
 *
 * @param deltaY 像素（正数向下）
 */
export async function browserScroll(deltaY: number): Promise<BrowserResult<{ y: number }>> {
  const contents = live();
  if (!contents) return { ok: false, error: NOT_ATTACHED };
  try {
    const y = (await contents.executeJavaScript(
      `(() => { window.scrollBy({ top: ${Math.trunc(deltaY)}, behavior: 'instant' }); return Math.round(window.scrollY); })()`,
      true,
    )) as number;
    return { ok: true, value: { y: Number(y) || 0 } };
  } catch (error) {
    return { ok: false, error: `滚动失败：${error instanceof Error ? error.message : String(error)}` };
  }
}

/**
 * 截当前页（落盘）。
 *
 * @returns 落盘路径与尺寸
 */
export async function browserScreenshot(): Promise<BrowserResult<{ path: string; width: number; height: number }>> {
  const contents = live();
  if (!contents) return { ok: false, error: NOT_ATTACHED };
  try {
    const image = await contents.capturePage();
    const size = image.getSize();
    const dir = shotsDir();
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `shot-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.png`);
    fs.writeFileSync(file, image.toPNG());
    return { ok: true, value: { path: file, width: size.width, height: size.height } };
  } catch (error) {
    return { ok: false, error: `截图失败：${error instanceof Error ? error.message : String(error)}` };
  }
}

/**
 * 把快照说成给模型看的一段文字。
 *
 * 形态：先一句页面信息，再一行一个元素，最后一段可见文字（标成不可信）。
 *
 * @param snapshot 快照
 */
export function describeSnapshot(snapshot: BrowserSnapshot): string {
  const head = [`页面：${snapshot.title || "(没有标题)"}`, `地址：${snapshot.url}`];
  if (snapshot.iframes) head.push(`（页面里有 ${snapshot.iframes} 个 iframe —— 它们的内容**看不到**，别假设页面只有这些）`);
  const elements = snapshot.elements.map(
    (e) => `${e.ref} ${e.role}「${e.name}」(${e.x},${e.y} ${e.w}×${e.h})`,
  );
  const truncated = snapshot.truncated.elements || snapshot.truncated.nodes ? "\n（快照已截断：元素或文字超出上限）" : "";
  return [
    head.join("\n"),
    "",
    `可交互元素（${snapshot.elements.length}）：`,
    elements.length ? elements.join("\n") : "（没有可交互元素）",
    truncated,
    "",
    markUntrusted("web", snapshot.text || "（没有可见文字）"),
  ].join("\n");
}

/**
 * 应用退出时解绑（B-01 之后这里**不销毁 webContents**）。
 *
 * 那个 webContents 属于右栏面板：它由渲染进程持有，窗口关掉时 Electron 自己会收。
 * 主进程在这里硬销毁反而会和面板的清理撞车（面板还会去 detach 一次）。
 */
export function closeBrowserHost(): void {
  agentContents = null;
}
