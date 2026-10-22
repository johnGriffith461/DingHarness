import { app, webContents as electronWebContents, type WebContents } from "electron";
import fs from "node:fs";
import path from "node:path";

import {
  buildRefSelector,
  buildSnapshotScript,
} from "../../shared/browserTools";
import { previewableUrl } from "../../shared/preview";
import { markUntrusted } from "../../shared/untrusted";
import { NOT_ATTACHED_NOTICE as NOT_ATTACHED, isAttachable } from "../../shared/browserAttach";
import { blockedReason } from "../../shared/browserUrl";

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
  return { ok: true, value: { id: contents.id } };
}

/** 面板卸载 / 关页时解绑。 */
export function detachFromWebContents(id?: number): void {
  if (!agentContents) return;
  if (typeof id === "number" && agentContents.id !== id) return;
  agentContents = null;
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
 * 取快照（注入脚本读 DOM）。
 *
 * @param opts.maxElements 最多列多少个可交互元素
 * @param opts.maxNodes 最多列多少段可见文字
 */
export async function browserSnapshot(opts: { maxElements?: number; maxNodes?: number } = {}): Promise<
  BrowserResult<BrowserSnapshot>
> {
  const contents = live();
  if (!contents) return { ok: false, error: NOT_ATTACHED };
  const script = buildSnapshotScript(opts.maxElements ?? 120, opts.maxNodes ?? 300);
  try {
    const raw = (await contents.executeJavaScript(script, true)) as BrowserSnapshot;
    const iframes = await contents.executeJavaScript("document.querySelectorAll('iframe').length", true);
    return { ok: true, value: { ...raw, iframes: Number(iframes) || 0 } };
  } catch (error) {
    return { ok: false, error: `取快照失败：${error instanceof Error ? error.message : String(error)}` };
  }
}

/**
 * 点一个 ref。
 *
 * 做法：在页面里 `el.click()` —— 对绝大多数框架（React/Vue）都成立，
 * 而且不需要算坐标（坐标会随滚动/缩放漂移，那是另一个要维护的东西）。
 *
 * @param ref 快照里的 `@N`
 */
export async function browserClick(ref: string): Promise<BrowserResult<{ name: string }>> {
  const contents = live();
  if (!contents) return { ok: false, error: NOT_ATTACHED };
  const selector = buildRefSelector(ref);
  if (!selector) return { ok: false, error: `ref 格式不对（要形如 @3）：${ref}` };
  try {
    const got = (await contents.executeJavaScript(
      `(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return { found: false };
        const label = (el.getAttribute('aria-label') || el.innerText || el.value || '').trim().slice(0, 60);
        el.scrollIntoView({ block: 'center' });
        el.click();
        return { found: true, label };
      })()`,
      true,
    )) as { found: boolean; label?: string };
    if (!got.found) return { ok: false, error: `页面上找不到 ${ref} —— 页面可能变了，重新取一次快照` };
    return { ok: true, value: { name: got.label || ref } };
  } catch (error) {
    return { ok: false, error: `点击失败：${error instanceof Error ? error.message : String(error)}` };
  }
}

/**
 * 往一个输入框里输入文字。
 *
 * 先聚焦、选中已有内容、再用 `Input.insertText`（走输入法通道，中文没问题）。
 *
 * @param ref 输入框 ref
 * @param text 文字
 * @param submit 输入后是否回车
 */
export async function browserType(
  ref: string,
  text: string,
  submit = false,
): Promise<BrowserResult<{ chars: number }>> {
  const contents = live();
  if (!contents) return { ok: false, error: NOT_ATTACHED };
  const selector = buildRefSelector(ref);
  if (!selector) return { ok: false, error: `ref 格式不对（要形如 @3）：${ref}` };
  try {
    const focused = (await contents.executeJavaScript(
      `(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return false;
        el.focus();
        if (typeof el.select === 'function') el.select();
        return document.activeElement === el;
      })()`,
      true,
    )) as boolean;
    if (!focused) return { ok: false, error: `${ref} 不是可聚焦的输入框（重新取一次快照看看它的 role）` };

    contents.debugger.attach("1.3");
    try {
      await contents.debugger.sendCommand("Input.insertText", { text });
      if (submit) {
        await contents.debugger.sendCommand("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
        await contents.debugger.sendCommand("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
      }
    } finally {
      contents.debugger.detach();
    }
    return { ok: true, value: { chars: text.length } };
  } catch (error) {
    return { ok: false, error: `输入失败：${error instanceof Error ? error.message : String(error)}` };
  }
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
