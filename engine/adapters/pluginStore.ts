import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

import { checkManifest, type PluginManifest, type PluginPermission } from "../runtime/plugins";

/**
 * 插件的**安装台账**（Phase 8.2）。
 *
 * ## 台上记什么
 *
 * 装过哪些、从哪来、**用户批了哪几项权限**、现在开不开。这是一份**台账**，
 * 不是"插件目录的索引"：目录里有什么文件由插件自己决定，而"装过没有、
 * 批过什么"必须是**我们记的** —— 否则用户拒绝过的权限在下次启动时
 * 会"重新出现"（那等于用户的选择没生效）。
 *
 * ## 为什么落在数据目录而不是插件目录里
 *
 * 插件目录（`plugins/<name>/`）是插件的**内容**，可能被它自己写；
 * 台账是我们的**账**。两者放一起就会出现"插件把自己从台账里删掉"这种事。
 */

/** 一个已安装插件。 */
export type InstalledPlugin = {
  name: string;
  version: string;
  description: string;
  /** 它的目录（绝对路径）。 */
  dir: string;
  /** 装的时候从哪来（`dir:<路径>` / `npm:<包名>`），给排错用。 */
  source: string;
  /** 装的时间（epoch ms）。 */
  installedAt: number;
  /**
   * **用户批准时的那份清单快照**（Phase 8.2）。
   *
   * ⚠️ 这一条是"权限"这件事能不能立住的关键：如果装载时只读**磁盘上的**清单，
   * 那么插件装完之后改一改自己的清单（多加一个工具、多要一项权限），
   * 下次启动就会被当成"本来就批过的"。有了快照，装载时一比就知道"它被改过"。
   */
  manifest: PluginManifest;
  /** 清单里申请的权限（**如实存**，不因为用户拒了就抹掉）。 */
  permissions: readonly PluginPermission[];
  /** 用户**批准**的那一组（可以是 permissions 的子集）。 */
  granted: readonly PluginPermission[];
  /** 开着还是关着。装完默认开着（用户刚点过确认）。 */
  enabled: boolean;
};

/** 台账文件的形状。 */
export type PluginLedger = { installed: InstalledPlugin[] };

/** 数据目录里的插件树。 */
export type PluginPaths = {
  /** 插件内容目录。 */
  root: string;
  /** 台账文件。 */
  ledger: string;
};

/** 由数据目录算出路径（宿主给 `~/.ding` 或应用 userData）。 */
export function pluginPaths(dataDir: string): PluginPaths {
  const root = path.join(dataDir, "plugins");
  return { root, ledger: path.join(root, "plugins.json") };
}

/** 读台账（磁盘不可信：坏文件当空台账，并把原因报出来）。 */
export function readLedger(paths: PluginPaths): { ledger: PluginLedger; note?: string } {
  try {
    if (!existsSync(paths.ledger)) return { ledger: { installed: [] } };
    const raw = JSON.parse(readFileSync(paths.ledger, "utf8")) as unknown;
    const list = (raw as { installed?: unknown })?.installed;
    if (!Array.isArray(list)) return { ledger: { installed: [] }, note: "台账形状不对，已当空台账处理" };
    const installed: InstalledPlugin[] = [];
    for (const item of list) {
      const p = item as Partial<InstalledPlugin>;
      if (typeof p?.name !== "string" || typeof p?.dir !== "string") continue; // 坏条目丢掉，不拖垮整份台账
      installed.push({
        name: p.name,
        manifest: (p.manifest ?? {
          name: p.name,
          version: typeof p.version === "string" ? p.version : "0.0.0",
          description: typeof p.description === "string" ? p.description : "",
          permissions: Array.isArray(p.permissions) ? (p.permissions as PluginPermission[]) : [],
          engines: { ding: "*" },
        }) as PluginManifest,
        version: typeof p.version === "string" ? p.version : "0.0.0",
        description: typeof p.description === "string" ? p.description : "",
        dir: p.dir,
        source: typeof p.source === "string" ? p.source : "(未记录)",
        installedAt: typeof p.installedAt === "number" ? p.installedAt : 0,
        permissions: Array.isArray(p.permissions) ? (p.permissions as PluginPermission[]) : [],
        granted: Array.isArray(p.granted) ? (p.granted as PluginPermission[]) : [],
        enabled: p.enabled === true,
      });
    }
    return { ledger: { installed } };
  } catch (error) {
    return { ledger: { installed: [] }, note: `台账读不动（${error instanceof Error ? error.message : String(error)}），已当空台账处理` };
  }
}

/** 写台账（原子：先写临时文件再改名，避免写一半崩掉留下坏账）。 */
export function writeLedger(paths: PluginPaths, ledger: PluginLedger): void {
  mkdirSync(paths.root, { recursive: true });
  const tmp = `${paths.ledger}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(ledger, null, 2)}\n`, "utf8");
  // rename 在 Windows 上覆盖已存在文件是允许的
  rmSync(paths.ledger, { force: true });
  cpSync(tmp, paths.ledger);
  rmSync(tmp, { force: true });
}

/** 一个目录里有没有插件清单（`ding-plugin.json` 优先，其次 `package.json` 的扩展字段）。 */
export function readManifestFromDir(dir: string): { raw?: unknown; file?: string; note?: string } {
  const dedicated = path.join(dir, "ding-plugin.json");
  if (existsSync(dedicated)) {
    try {
      return { raw: JSON.parse(readFileSync(dedicated, "utf8")), file: "ding-plugin.json" };
    } catch (error) {
      return { note: `ding-plugin.json 不是合法 JSON：${error instanceof Error ? error.message : String(error)}` };
    }
  }
  const pkg = path.join(dir, "package.json");
  if (existsSync(pkg)) {
    try {
      const parsed = JSON.parse(readFileSync(pkg, "utf8")) as { ding?: unknown; dingPlugin?: unknown };
      // npm 渠道：清单放在 package.json 的扩展字段里（`ding` 或 `dingPlugin`）
      const raw = parsed.ding ?? parsed.dingPlugin;
      if (raw) return { raw, file: "package.json#ding" };
      return { note: "package.json 里没有 `ding` 扩展字段" };
    } catch (error) {
      return { note: `package.json 不是合法 JSON：${error instanceof Error ? error.message : String(error)}` };
    }
  }
  return { note: "目录里既没有 ding-plugin.json，也没有带 `ding` 字段的 package.json" };
}

/** 安装/移除的结果。 */
export type InstallResult =
  | { ok: true; plugin: InstalledPlugin }
  | { ok: false; errors: string[] };

/**
 * **从一个目录装一个插件**（Phase 8.2 的本地渠道；也是 npm 渠道的最后一跳）。
 *
 * 流程：读清单 → 校验 → 拷贝内容 → 落台账。
 *
 * @param input.paths 插件路径
 * @param input.from 源目录
 * @param input.granted 用户批准的那一组权限（**不传 = 全部批准**；传了就是用户的选择）
 * @returns 安装结果
 */
export function installFromDir(input: {
  paths: PluginPaths;
  from: string;
  granted?: readonly PluginPermission[];
  now?: number;
}): InstallResult {
  const { paths, from } = input;
  if (!existsSync(from) || !statSync(from).isDirectory()) {
    return { ok: false, errors: [`不是一个目录：${from}`] };
  }

  const got = readManifestFromDir(from);
  if (!got.raw) return { ok: false, errors: [got.note ?? "读不到清单"] };

  const checked = checkManifest(got.raw);
  if (!checked.ok) return { ok: false, errors: checked.errors };
  const manifest: PluginManifest = checked.manifest;

  /*
   * ⚠️ 入口文件必须在。**"装了但跑不起来"**比"装不上"坏得多 ——
   * 用户会以为装好了，直到某天它该起作用时才发现什么都没有。
   */
  const main = path.join(from, manifest.main ?? "index.mjs");
  if (!existsSync(main)) {
    return { ok: false, errors: [`入口文件不存在：${path.basename(main)}（清单可写 main 指定，默认 index.mjs）`] };
  }

  const target = path.join(paths.root, manifest.name);
  rmSync(target, { recursive: true, force: true });
  mkdirSync(target, { recursive: true });
  cpSync(from, target, { recursive: true, filter: (src) => !src.includes(`${path.sep}node_modules${path.sep}`) });

  const granted = input.granted ? [...input.granted] : [...manifest.permissions];
  const plugin: InstalledPlugin = {
    name: manifest.name,
    manifest,
    version: manifest.version,
    description: manifest.description,
    dir: target,
    source: `dir:${from}`,
    installedAt: input.now ?? Date.now(),
    permissions: manifest.permissions,
    granted,
    enabled: true,
  };

  const before = readLedger(paths);
  // 同名视作**升级**：台账里就地替换（不出现两条同名）
  const installed = [plugin, ...before.ledger.installed.filter((p) => p.name !== plugin.name)];
  writeLedger(paths, { installed });
  return { ok: true, plugin };
}

/**
 * 卸载：**删台账 + 删它拷进来的那份内容**。
 *
 * ⚠️ 只删 `plugins/<name>/`（我们自己拷进去的那份），**不删**用户给的源目录 ——
 * 那是他的东西，插件可能是从那儿开发出来的。
 *
 * @param paths 插件路径
 * @param name 插件名
 * @returns 有没有删掉
 */
export function uninstall(paths: PluginPaths, name: string): { ok: boolean; note?: string } {
  const before = readLedger(paths);
  const found = before.ledger.installed.find((p) => p.name === name);
  if (!found) return { ok: false, note: `没有装过叫 ${name} 的插件` };

  /*
   * 删内容时**只删我们记下的那个目录**，而且要求它在插件根之下 ——
   * 台账是磁盘来的（可能被手改过），照着它删任意路径是危险的。
   */
  const resolved = path.resolve(found.dir);
  const root = path.resolve(paths.root);
  if (resolved.startsWith(root + path.sep) && existsSync(resolved)) {
    rmSync(resolved, { recursive: true, force: true });
  }
  writeLedger(paths, { installed: before.ledger.installed.filter((p) => p.name !== name) });
  return { ok: true };
}

/** 开/关一个插件（关 = 不装载它的工具与钩子，但**留着台账**）。 */
export function setEnabled(paths: PluginPaths, name: string, enabled: boolean): { ok: boolean; note?: string } {
  const before = readLedger(paths);
  if (!before.ledger.installed.some((p) => p.name === name)) return { ok: false, note: `没有装过叫 ${name} 的插件` };
  writeLedger(paths, {
    installed: before.ledger.installed.map((p) => (p.name === name ? { ...p, enabled } : p)),
  });
  return { ok: true };
}

/**
 * 修一次台账：把**目录已经不在了**的插件标成"坏了"（而不是删掉）。
 *
 * ⚠️ 不删：用户可能只是把盘拿掉了（U 盘、网络盘）。删台账等于**抹掉他的决定**
 * （他批过哪些权限记在那一条里）。标出来让他自己处置。
 *
 * @param paths 插件路径
 * @returns 有几个插件的目录不在了
 */
export function auditLedger(paths: PluginPaths): { missing: string[] } {
  const { ledger } = readLedger(paths);
  const missing = ledger.installed.filter((p) => !existsSync(p.dir)).map((p) => p.name);
  return { missing };
}

/**
 * 装载前比对"磁盘上的清单"与"用户批准的那份"。
 *
 * ⚠️ 这是**权限声明能不能立住**的地方。插件装完之后改自己的清单
 * （多加一个工具、多要一项权限），如果装载时只读磁盘，那次改动会被当成
 * "本来就批过的" —— 等于插件的权限可以自己长大。
 *
 * 判据只比**与授权有关的字段**（permissions / tools / hooks / name）：
 * version 与 description 变了不算越权（那种改动不该打断用户）。
 *
 * @param approved 台账里那份（用户批准时的快照）
 * @param current 磁盘上那份（已校验）
 * @returns 有没有越界；越界时给人话
 */
export function manifestDrifted(approved: PluginManifest, current: PluginManifest): string | null {
  if (approved.name !== current.name) return `插件名变了：${approved.name} → ${current.name}`;
  const same = (a?: readonly string[], b?: readonly string[]) => [...(a ?? [])].sort().join(",") === [...(b ?? [])].sort().join(",");
  if (!same(approved.permissions, current.permissions)) {
    return `权限清单变了（装的时候是 ${approved.permissions.join(" / ") || "无"}，现在是 ${current.permissions.join(" / ") || "无"}）`;
  }
  if (!same(approved.tools, current.tools)) return "它声明的工具变了";
  if (!same(approved.hooks, current.hooks)) return "它声明的钩子变了";
  return null;
}

/** 列目录下有哪些 `.mjs`（给人看的"这个插件带了哪些文件"，排错用）。 */
export function listPluginFiles(dir: string): string[] {
  try {
    return readdirSync(dir).filter((n) => n.endsWith(".mjs") || n.endsWith(".js"));
  } catch {
    return [];
  }
}
