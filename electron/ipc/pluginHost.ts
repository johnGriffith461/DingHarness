import { app, dialog, type BrowserWindow } from "electron";

import {
  auditLedger,
  installFromDir,
  pluginPaths,
  readLedger,
  setEnabled,
  uninstall,
  type InstalledPlugin,
} from "../../engine/adapters/pluginStore";
import { loadEnabledPlugins, loadedPlugins, withheldCapabilities } from "../../engine/runtime/pluginHost";
import { ENFORCED_PERMISSIONS, type PluginPermission } from "../../engine/runtime/plugins";

/**
 * 桌面的插件 IPC（Phase 8.4）。
 *
 * ## 两件事在这一层
 *
 * 1. **启动时装载**：把台账里开着的插件装进内存（工具随即进注册表）。
 *    装载失败只打日志、**不拦启动** —— 一个坏插件不该让应用起不来。
 * 2. **给界面那套读写**：列 / 从目录安装 / 开关 / 卸载 / 体检。
 *
 * ## ⚠️ 一条安全边界（与工作区授权同一个口径）
 *
 * **目录是系统对话框给的，不接受渲染进程传路径**。
 * 与用户授权工作区那条理由一样：如果渲染层能指定任意路径，
 * "安装"就等于"让主进程去执行任意目录里的代码" —— 那是个不该开的口子。
 */

export const PLUGIN_CHANNEL = {
  list: "plugin:list",
  install: "plugin:install",
  setEnabled: "plugin:setEnabled",
  uninstall: "plugin:uninstall",
  doctor: "plugin:doctor",
} as const;

/** 给界面看的一条（脱敏 + 加上装载时发现的问题）。 */
export type PluginView = {
  name: string;
  version: string;
  description: string;
  enabled: boolean;
  /** 用户批准的权限。 */
  granted: readonly PluginPermission[];
  /** 它申请的（可能多于批准的）。 */
  requested: readonly PluginPermission[];
  /** 申请了但没批的**注入类**权限（那几项真的不生效）。 */
  withheld: readonly PluginPermission[];
  /** 申请了的**资源类**权限（v1 只声明不拦 —— 界面上要说清）。 */
  declaredOnly: readonly PluginPermission[];
  /** 装载时发现的问题（目录不在、被改过、声明与实现不一致…）。 */
  problems: string[];
  /** 它现在真的接上了几个工具（0 = 没有）。 */
  toolCount: number;
};

function pluginPathsNow() {
  return pluginPaths(app.getPath("userData"));
}

/** 组装给界面看的列表（**把"没生效"这件事如实写出来**，而不是只报名字）。 */
export function pluginViews(): PluginView[] {
  const { installed } = readLedger(pluginPathsNow()).ledger;
  const loadedByName = new Map(loadedPlugins().map((p) => [p.name, p]));
  return installed.map((item: InstalledPlugin) => {
    const loaded = loadedByName.get(item.name);
    const withheld = loaded?.withheld ?? [];
    return {
      name: item.name,
      version: item.version,
      description: item.description,
      enabled: item.enabled,
      granted: item.granted,
      requested: item.permissions,
      withheld,
      declaredOnly: item.permissions.filter((p) => !ENFORCED_PERMISSIONS.includes(p)),
      problems: loaded?.problems ?? (item.enabled ? [] : []),
      toolCount: loaded?.entries.length ?? 0,
    };
  });
}

/** 体检结论（列表之外的那几句）。 */
export async function pluginDoctor(): Promise<{ missing: string[]; withheld: { plugin: string; permissions: readonly PluginPermission[] }[] }> {
  const paths = pluginPathsNow();
  const { missing } = auditLedger(paths);
  return { missing, withheld: withheldCapabilities() };
}

/**
 * 启动时装载一次（幂等）。
 *
 * ⚠️ 失败**不抛**：插件是"用户后来装的东西"，它坏了不该让应用起不来。
 */
export async function loadPluginsAtStartup(): Promise<void> {
  try {
    const { installed } = readLedger(pluginPathsNow()).ledger;
    const loaded = await loadEnabledPlugins(installed);
    const problems = loaded.flatMap((p) => p.problems.map((x) => `${p.name}：${x}`));
    if (loaded.length) console.log(`[plugin] 装载了 ${loaded.length} 个插件（${loaded.reduce((n, p) => n + p.entries.length, 0)} 个工具）`);
    for (const problem of problems) console.warn(`[plugin] ${problem}`);
  } catch (error) {
    console.error("[plugin] 装载失败（不影响应用启动）：", error instanceof Error ? error.message : error);
  }
}

/**
 * 注册插件的 IPC。
 *
 * @param ipcMain Electron 的 ipcMain
 * @param getWindow 取主窗口（目录对话框要挂在它上面）
 */
export function registerPluginIpc(ipcMain: Electron.IpcMain, getWindow: () => BrowserWindow | null): void {
  ipcMain.handle(PLUGIN_CHANNEL.list, () => pluginViews());
  ipcMain.handle(PLUGIN_CHANNEL.doctor, () => pluginDoctor());

  /*
   * 从目录安装：**目录由系统对话框给**（不接受渲染进程传路径）。
   * 装完立刻重新装载，这样"装好了马上能用"，而不是要重启。
   */
  ipcMain.handle(PLUGIN_CHANNEL.install, async () => {
    const win = getWindow();
    const picked = win
      ? await dialog.showOpenDialog(win, { properties: ["openDirectory"], title: "选一个插件目录" })
      : await dialog.showOpenDialog({ properties: ["openDirectory"], title: "选一个插件目录" });
    if (picked.canceled || !picked.filePaths.length) return { ok: false as const, canceled: true as const };
    const paths = pluginPathsNow();
    const got = installFromDir({ paths, from: picked.filePaths[0] });
    if (!got.ok) return { ok: false as const, errors: got.errors };
    await loadPluginsAtStartup();
    return { ok: true as const, plugin: got.plugin.name, list: pluginViews() };
  });

  ipcMain.handle(PLUGIN_CHANNEL.setEnabled, async (_e, name: unknown, enabled: unknown) => {
    if (typeof name !== "string" || typeof enabled !== "boolean") return { ok: false as const, errors: ["参数不对"] };
    const got = setEnabled(pluginPathsNow(), name, enabled);
    if (!got.ok) return { ok: false as const, errors: [got.note ?? "没成功"] };
    await loadPluginsAtStartup();
    return { ok: true as const, list: pluginViews() };
  });

  ipcMain.handle(PLUGIN_CHANNEL.uninstall, async (_e, name: unknown) => {
    if (typeof name !== "string") return { ok: false as const, errors: ["参数不对"] };
    const got = uninstall(pluginPathsNow(), name);
    if (!got.ok) return { ok: false as const, errors: [got.note ?? "没成功"] };
    await loadPluginsAtStartup();
    return { ok: true as const, list: pluginViews() };
  });
}
