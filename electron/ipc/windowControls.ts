import { BrowserWindow, type IpcMain, type IpcMainInvokeEvent } from "electron";

/**
 * 窗口控制（最小化 / 最大化·还原 / 关闭）。
 *
 * ## 为什么窗口按钮由应用自己画（2026-10-15，M0 工单 1）
 *
 * 原来是 `titleBarOverlay`：Windows 会在**窗体顶部的覆盖层**里画一套原生 caption 按钮。
 * 它的位置是固定的 —— 右上角约 138×36（DIP）—— 应用既改不了尺寸也挪不动它。
 *
 * 而本应用的「云盘 / 插件·技能·伙伴 / 定时任务」三个视图**自己的操作按钮就在右上角**：
 * 实测 DOM 坐标 `wb-cloud-new` / `wb-plugin-add` / `wb-sched-new` 都在 x=1359..1426（视口宽 1440），
 * 而覆盖层从 x≈1302 起 —— 原生按钮正好**压在「上传 / 新建」上面**。
 * OS 层实拍（`.verify/m0/repro-cloud-topright.png`）能看到应用按钮被压掉半个字。
 * 用户看到的就是"右上角按钮重复显示"：同一个角落挤着两簇按钮。
 *
 * 覆盖层删掉之后，右上角这一条**必须有人画按钮**，否则用户连关窗口的地方都没有。
 * 所以窗口控制搬进应用手里 —— 顺带把配色交回主题（原来原生覆盖层改个颜色还得单开一条 IPC）。
 *
 * ## 拖动
 * `titleBarStyle: "hidden"` 之后窗口靠 CSS 的 `-webkit-app-region: drag` 拖。
 * 自绘标题栏（`src/workbench/TitleBar.tsx`）就是那条拖动区，并且在布局里**独占一行**
 * （`.wb` 用 padding-top 让所有内容从它下面开始）—— 这样它底下永远是空的，
 * 不会出现"拖拽区吞掉按钮点击"那类问题（`FloatingAssistant.tsx:52` 记过一次）。
 */

/** 通道名。 */
export const WINDOW_CHANNEL = {
  /** 最小化窗口。 */
  minimize: "win:minimize",
  /** 最大化 ⇄ 还原（当前状态决定方向）。 */
  toggleMaximize: "win:toggleMaximize",
  /** 关闭窗口。 */
  close: "win:close",
  /** 读当前是否最大化（自绘按钮据此决定画"最大化"还是"还原"图标）。 */
  isMaximized: "win:isMaximized",
  /** 主进程 → 渲染进程：最大化状态变了。 */
  maximizedChanged: "win:maximizedChanged",
} as const;

/** 拿主进程里那个窗口（本应用是单窗口，由 `main.ts` 交进来）。 */
type GetWindow = () => BrowserWindow | null;

/**
 * 由事件找到**发起方那个**窗口，拿不到才退回单例。
 *
 * 单窗口时两者一样；但 `main.ts` 的 `activate`（macOS 重新点开图标）会再建一个窗口，
 * 那时用单例就会去控制"另一个"窗口 —— 点这个窗口的关闭按钮，关掉的是那个。
 */
function windowOf(event: IpcMainInvokeEvent, fallback: GetWindow): BrowserWindow | null {
  return BrowserWindow.fromWebContents(event.sender) ?? fallback();
}

/**
 * 把「最大化状态变了」推给渲染进程。
 *
 * 为什么不能只在点击时回一个值：用户还有**别的**路径改变最大化状态 ——
 * 双击标题栏、Win+↑、把窗口拖到屏幕边缘触发 Snap。那些都不经过我们的按钮，
 * 不推事件的话自绘图标会一直停在旧状态（明明是"还原"却画着"最大化"）。
 *
 * @param win 新建出来的窗口
 */
export function attachWindowEvents(win: BrowserWindow): void {
  const push = (maximized: boolean) => {
    if (win.isDestroyed()) return;
    win.webContents.send(WINDOW_CHANNEL.maximizedChanged, maximized);
  };
  win.on("maximize", () => push(true));
  win.on("unmaximize", () => push(false));
}

/**
 * 注册窗口控制 IPC。
 *
 * @param ipcMainInstance Electron 的 ipcMain
 * @param getWindow 取当前窗口（单例兜底）
 */
export function registerWindowIpc(ipcMainInstance: IpcMain, getWindow: GetWindow): void {
  ipcMainInstance.handle(WINDOW_CHANNEL.minimize, (event) => {
    windowOf(event, getWindow)?.minimize();
  });

  ipcMainInstance.handle(WINDOW_CHANNEL.toggleMaximize, (event) => {
    const win = windowOf(event, getWindow);
    if (!win) return false;
    if (win.isMaximized()) win.unmaximize();
    else win.maximize();
    /*
     * 回的是**操作后**的真实状态，不是"我打算做什么" ——
     * `maximize()` 在有的机型 / 多显示器组合上不会立刻生效，回意图就会让图标撒谎。
     */
    return win.isMaximized();
  });

  ipcMainInstance.handle(WINDOW_CHANNEL.close, (event) => {
    windowOf(event, getWindow)?.close();
  });

  ipcMainInstance.handle(WINDOW_CHANNEL.isMaximized, (event) => {
    return windowOf(event, getWindow)?.isMaximized() ?? false;
  });
}
