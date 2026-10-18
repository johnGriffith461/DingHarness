import { rmSync } from "node:fs";
import { app, dialog, type BrowserWindow } from "electron";

import {
  auditLedger,
  installFromDir,
  installFromTarball,
  makePackDir,
  packNpm,
  pluginPaths,
  readLedger,
  readManifestFromDir,
  readManifestFromTarball,
  setEnabled,
  uninstall,
  type InstalledPlugin,
} from "../../engine/adapters/pluginStore";
import { loadEnabledPlugins, loadedPlugins, withheldCapabilities } from "../../engine/runtime/pluginHost";
import {
  checkManifest,
  DECLARATION_ONLY_PERMISSIONS,
  ENFORCED_PERMISSIONS,
  SANDBOXED_PERMISSIONS,
  type PluginManifest,
  type PluginPermission,
} from "../../engine/runtime/plugins";

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

/**
 * 这个字符串能不能当 **npm 包名**用。
 *
 * ⚠️ 它是"发现 + 安装"那道口子的守卫：包名不是路径。
 * 不校验的话 `../某处` / `C:\...` / `file:...` 都能被 `npm pack` 认下来，
 * 于是"从 npm 装插件"变成"让主进程执行任意本地目录"。
 *
 * 规则（npm 自己的口径，收窄到常见的那些）：可选的 `@scope/`，名字用小写字母数字与 `-_.`，
 * 可带 `@版本`；**不许**出现路径分隔符、`..`、协议前缀。
 *
 * @param spec 渲染进程给的包名
 * @returns 能不能用
 */
export function isSafeNpmSpec(spec: string): boolean {
  if (spec.length > 120) return false;
  if (spec.includes("..") || spec.includes(":") || /[\/]/.test(spec.replace(/^@[^/]+\//, ""))) return false;
  return /^(@[a-z0-9-_.]+\/)?[a-z0-9-_.]+(@[a-zA-Z0-9-.^~><= ]+)?$/.test(spec);
}

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
      /* 隔离进程强制的资源项（宿主支持权限模型时；降级时 isolation 会说是 worker） */
      sandboxed: item.permissions.filter((p) => SANDBOXED_PERMISSIONS.includes(p)),
      /* 仍然拦不住的：只剩 net（Node 没有网络权限那一格） */
      declaredOnly: item.permissions.filter((p) => DECLARATION_ONLY_PERMISSIONS.includes(p)),
      ...(loaded?.isolation ? { isolation: loaded.isolation } : {}),
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
 * **装之前先把"它要什么权限"给用户看，点头才装**（2026-10-16，审计 P01）。
 *
 * ## 缺陷形状（这是"装即全量授权"的正面判据）
 *
 * 原来桌面这条路 `installFromNpm({paths, spec})` **不传 `granted`** ——
 * 而 `pluginStore.installFromDir` 的规则是"不传 = 全部批准"，
 * 于是桌面上装一个 npm 插件 = **装完就把它申请的权限全批了**，而且
 * 下一行 `loadPluginsAtStartup()` 立刻在主进程里 import 执行它的代码。
 * CLI 侧早就是两段式（先取包读清单给用户看，`--yes` 才装，`--grant` 挑权限）——
 * 同一台机器上，命令行装插件有确认，界面点一下就全量授权。
 *
 * 这里补上缺的那一段：**弹原生确认框列出它申请的每一项**，用户点了才装，
 * 并且只把他在框里看到的那一组 `granted` 传下去（不是"默认全批"）。
 *
 * ⚠️ **fail-closed**：没有窗口可挂（`getWindow()` 为 null）时不问也不装 ——
 * "问不了就默认同意"是这类缺陷的另一种写法。
 *
 * @param win 主窗口（挂对话框用）
 * @param manifest 已校验过的清单
 * @returns 用户是否同意安装
 */
async function confirmInstall(win: BrowserWindow | null, manifest: PluginManifest): Promise<boolean> {
  if (!win) return false;
  const enforced = manifest.permissions.filter((p) => ENFORCED_PERMISSIONS.includes(p));
  const sandboxed = manifest.permissions.filter((p) => SANDBOXED_PERMISSIONS.includes(p));
  const declaredOnly = manifest.permissions.filter((p) => DECLARATION_ONLY_PERMISSIONS.includes(p));
  const detail = [
    manifest.description,
    "",
    `它申请的权限：${manifest.permissions.length ? manifest.permissions.join(" / ") : "（无）"}`,
    enforced.length ? `· 这几项**会真的生效**（不批它就不接那根线）：${enforced.join(" / ")}` : "",
    sandboxed.length
      ? `· 这几项在**隔离进程**里强制（只能碰插件目录；写/起子进程要单独批准）：${sandboxed.join(" / ")}`
      : "",
    declaredOnly.length
      ? `· 这几项**拦不住**（Node 没有网络权限那一格）—— 是"知情"，不是"限制"：${declaredOnly.join(" / ")}`
      : "",
    "",
    "插件代码会在独立进程里执行（不是主进程）。只装你信得过的。",
  ]
    .filter(Boolean)
    .join("\n");
  const { response } = await dialog.showMessageBox(win, {
    type: "question",
    buttons: ["安装", "取消"],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
    title: "装这个插件？",
    message: `${manifest.name}@${manifest.version}`,
    detail,
  });
  return response === 0;
}

/** 读清单 + 校验；两条安装渠道共用（失败时给能直接给用户看的错误）。 */
function checkedManifestOf(peek: { raw?: unknown; note?: string }): { ok: true; manifest: PluginManifest } | { ok: false; errors: string[] } {
  if (!peek.raw) return { ok: false, errors: [peek.note ?? "读不到清单"] };
  const checked = checkManifest(peek.raw);
  return checked.ok ? { ok: true, manifest: checked.manifest } : { ok: false, errors: checked.errors };
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
   * 安装（Phase 8.4 的"发现 + 安装"）：
   * - **不给 `spec`** → 弹系统目录对话框装本地目录（目录由对话框给，不收渲染进程的路径）；
   * - **给 `spec`** → 从 npm 装（`npm:包名`）。⚠️ 这个值是**渲染进程给的**，
   *   所以只允许**严格的包名**（见 `isSafeNpmSpec`）：包名不是路径。
   *   不校验的话 `npm pack ../某处` 就成了一条"让主进程去执行任意本地目录"的路 ——
   *   那与"不收路径"的初衷直接矛盾。
   *
   * ⚠️ 两条渠道都是**两段式**（2026-10-16，审计 P01）：
   * 取包/读清单 → **确认框列出权限** → 才装，且只批用户在框里看到的那一组。
   * npm 那条**先取包再问**：先问再取的话，用户同意的是"一个还没下载的东西"，
   * 而清单（也就是它会要什么）恰恰只有拿到包才知道。
   */
  ipcMain.handle(PLUGIN_CHANNEL.install, async (_e, spec: unknown) => {
    const paths = pluginPathsNow();
    const win = getWindow();

    if (typeof spec === "string" && spec.trim()) {
      const wanted = spec.trim();
      if (!isSafeNpmSpec(wanted)) {
        return { ok: false as const, errors: [`只允许 npm 包名（可带 @版本），不接受路径：${wanted.slice(0, 60)}`] };
      }
      const tmp = makePackDir();
      try {
        const packed = packNpm(wanted, tmp);
        if (!packed.ok) return { ok: false as const, errors: packed.errors };
        const got = checkedManifestOf(readManifestFromTarball(packed.tgz));
        if (!got.ok) return { ok: false as const, errors: got.errors };
        if (!(await confirmInstall(win, got.manifest))) return { ok: false as const, canceled: true as const };
        const installed = installFromTarball({ paths, tgz: packed.tgz, granted: got.manifest.permissions });
        if (!installed.ok) return { ok: false as const, errors: installed.errors };
        await loadPluginsAtStartup();
        return { ok: true as const, plugin: installed.plugin.name, list: pluginViews() };
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    }

    const picked = win
      ? await dialog.showOpenDialog(win, { properties: ["openDirectory"], title: "选一个插件目录" })
      : await dialog.showOpenDialog({ properties: ["openDirectory"], title: "选一个插件目录" });
    if (picked.canceled || !picked.filePaths.length) return { ok: false as const, canceled: true as const };
    const from = picked.filePaths[0]!;
    const got = checkedManifestOf(readManifestFromDir(from));
    if (!got.ok) return { ok: false as const, errors: got.errors };
    if (!(await confirmInstall(win, got.manifest))) return { ok: false as const, canceled: true as const };
    const installed = installFromDir({ paths, from, granted: got.manifest.permissions });
    if (!installed.ok) return { ok: false as const, errors: installed.errors };
    await loadPluginsAtStartup();
    return { ok: true as const, plugin: installed.plugin.name, list: pluginViews() };
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
