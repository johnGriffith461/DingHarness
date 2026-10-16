import { app, dialog, shell } from "electron";
import fs from "node:fs/promises";
import path from "node:path";
import { kindOf, type DriveEntry, type DriveKind } from "../../shared/drive";
import { isUnsupported, type ImportItem } from "../../shared/upload";
import { READ_MAX_BYTES } from "../../shared/drive";
// 生成图落的目录（与 imageGen 同一处，不另写一份路径）
import { assetsDir } from "./imageGen";
import { insideDirs } from "../../engine/runtime/tools/drivePaths";
import { workspaceDirsSync } from "./workspaceStore";

/**
 * 云盘（阶段 11.5）。
 *
 * ## 为什么不是"再写一份假数据"
 * 云盘页原来是**遍历原版时的截图里那几行文件名** —— 那等于把"当时看到的东西"
 * 当成了实现，换个账号一行都不对。这里接**真实目录**，看到的每一条都是磁盘上真有的文件。
 *
 * ## 三个来源目录
 * - `artifacts/` —— 任务产出的产物（阶段 11.1/11.2 落的那批）
 * - `exports/` —— 画布导出的 PNG
 * - `drive/` —— 用户从外面导进云盘的文件
 *
 * 三个来源都列在一起、用 `origin` 区分来源，因为用户视角里它们都是"我的文件"。
 */

/*
 * ⚠️ A1：这里原来**又写了一份** `READ_MAX_BYTES = 200 * 1024`。
 * `shared/driveFiles.ts` 已经有同名常量，而且是渲染侧与新单测认的那一份
 * （`src/workbench/driveFiles.test.ts` 直接断言它是 `200 * 1024`）。
 * 两份值当时一样，但"改一处忘另一处"就是下一条静默不一致 ——
 * 所以改成从那边导入，只留**一个**事实来源。
 */

export const DRIVE_CHANNEL = {
  list: "drive:list",
  import: "drive:import",
  importPaths: "drive:importPaths",
  importData: "drive:importData",
  remove: "drive:remove",
  reveal: "drive:reveal",
  open: "drive:open",
  duplicate: "drive:duplicate",
  create: "drive:create",
  mkdir: "drive:mkdir",
  rename: "drive:rename",
  download: "drive:download",
  read: "drive:read",
} as const;

/** 云盘本体目录（用户导进来的文件）。 */
export function driveDir(): string {
  return path.join(app.getPath("userData"), "drive");
}

/** 产物目录。 */
function artifactsDir(): string {
  return path.join(app.getPath("userData"), "artifacts");
}

/** 画布导出目录。 */
function exportsDir(): string {
  return path.join(app.getPath("userData"), "exports");
}

/**
 * **允许读的目录**（绝对路径）——给 agent 的「读文件」工具用（2026-10-14）。
 *
 * ⚠️ 与 `drive:read` 用**同一份** `sources()`：两个入口各写一份白名单的话，
 * "界面上能读的"与"agent 能读的"迟早分叉，而分叉的方向通常是其中一边变松。
 */
export function ownedDirs(): string[] {
  /*
   * 加上**用户授权的工作区**（2026-10-14）。
   *
   * 这是"agent 能不能真干活"的关键一步：在那之前它能碰的只有本应用自己的四个目录
   * （云盘 / 产物 / 导出 / 生成图），那些里面是用户导进来的**副本** ——
   * 于是"帮我整理这个文件夹""在这个项目里跑测试"一件都做不到。
   *
   * ⚠️ 工作区排在**最后**：`dirs[0]` 是"没指定目录时的默认落点"，
   * 默认应该是云盘（用户熟悉的地方），而不是某个被授权的项目目录。
   */
  return [...sources().map((s) => s.dir), ...workspaceDirsSync()];
}

/** 三个来源目录与它们的 origin 标签。 */
function sources(): Array<{ dir: string; origin: DriveEntry["origin"] }> {
  return [
    { dir: artifactsDir(), origin: "artifact" },
    { dir: exportsDir(), origin: "export" },
    { dir: driveDir(), origin: "drive" },
    /*
     * `assets/` —— **生成的图片**落在这里（§166）。
     *
     * 原来只扫前三个目录，于是"生成了一张图"在云盘里**根本看不到**：
     * 它只存在于生成页那一份内存列表里，关掉就没了。
     * 加进来之后：生成的东西在云盘里能看、能筛、能重命名、能删。
     */
    { dir: assetsDir(), origin: "asset" },
  ];
}

/**
 * 列出一个目录里的文件。
 *
 * @param dir 目录
 * @param origin 来源标签
 * @returns 条目；目录不存在时返回空数组（**不是错误** —— 还没产出过东西时目录就是没有）
 */
async function listDir(dir: string, origin: DriveEntry["origin"]): Promise<DriveEntry[]> {
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch {
    return [];
  }
  const out: DriveEntry[] = [];
  for (const name of names) {
    const full = path.join(dir, name);
    try {
      const stat = await fs.stat(full);
      if (!stat.isFile()) continue;
      // 隐藏文件不列（.DS_Store 之类）
      if (name.startsWith(".")) continue;
      out.push({
        name,
        path: full,
        bytes: stat.size,
        createdAt: stat.birthtimeMs || stat.ctimeMs,
        modifiedAt: stat.mtimeMs,
        kind: kindOf(name) as DriveKind,
        origin,
      });
    } catch {
      // 单个文件读不到就跳过，不影响整个列表
    }
  }
  return out;
}

/**
 * 列出全部云盘文件。
 *
 * **同名去重**：产物与导出目录里可能有同名文件（例如两次导出都叫 `画布.png`）。
 * 名字是界面上唯一的标识（也是收藏的依据），所以同名时靠前的来源优先。
 *
 * @returns 去重后的条目
 */
export async function listDrive(): Promise<DriveEntry[]> {
  const groups = await Promise.all(sources().map(({ dir, origin }) => listDir(dir, origin)));
  const seen = new Set<string>();
  const out: DriveEntry[] = [];
  for (const group of groups) {
    for (const entry of group) {
      if (seen.has(entry.name)) continue;
      seen.add(entry.name);
      out.push(entry);
    }
  }
  return out;
}

/**
 * 校验路径确实在我们自己的来源目录里。
 *
 * 跨进程边界上必须挡一手：不校验的话渲染进程传任意路径就能让主进程删它 / 打开它。
 *
 * ⚠️ A1：**判断本体搬到了 `./drivePaths.ts`** ——
 * 那是为了让这条判断能在 Electron 之外被断言（本文件顶层 import 了 `electron`，
 * 主进程又没有测试基础设施，于是这道校验此前**一条测试都没有**）。
 * 这里只保留"白名单从哪来"这一层，`remove` / `duplicate` / `reveal` / `open`
 * 的调用点与语义**一字未动**。
 *
 * @param raw 渲染进程给的路径
 * @returns 通过校验的绝对路径；不通过返回 null
 */
function insideOwnedDirs(raw: string): string | null {
  return insideDirs(
    raw,
    sources().map(({ dir }) => dir),
  );
}

/**
 * 注册云盘 IPC。
 *
 * @param ipcMain Electron 的 ipcMain
 * @param getWindow 取主窗口（导入用的对话框要挂在它上面）
 */
/** 一次导入的结果（**按文件**回报，不只是数量）。 */
export type ImportOutcome = { imported: number; dir: string; items: ImportItem[] };

/**
 * 把一批路径导入云盘（§170）。
 *
 * ⚠️ 与原来只回一个数字的版本相比，这里**按文件回报**：
 * 哪几个进来了、哪几个没进来、为什么 —— 上传状态面板要靠它。
 *
 * 两条失败原因（都是证据里的词）：
 * - `formatUnsupported`：可执行 / 安装包那一类（见 `shared/upload.ts` 的拒绝清单）；
 * - `parseFail`：读不了或拷不过去。
 *
 * 单个文件失败**不会**让整批失败（原来也是这个口径）。
 *
 * @param sources 源文件路径
 * @returns 结果（`items` 与 `sources` 一一对应）
 */
/**
 * 往云盘里放一份字节（§171）。
 *
 * @param dir 云盘目录
 * @param name 想要的文件名（重名会加序号）
 * @param write 真正落盘的动作
 * @returns 结果条目
 */
async function putIntoDrive(
  dir: string,
  name: string,
  write: (target: string) => Promise<void>,
): Promise<ImportItem> {
  if (isUnsupported(name)) return { name, ok: false, reason: "formatUnsupported" };
  try {
    const target = await uniqueName(dir, name);
    await write(path.join(dir, target));
    return { name, ok: true, savedAs: target };
  } catch {
    return { name, ok: false, reason: "parseFail" };
  }
}

/**
 * 导入源的**准入校验**（2026-10-16，审计 X01 / P03 / P04）。
 *
 * ## 为什么要它
 *
 * `importPaths` 的源路径是**渲染进程给的**（拖拽事件的路径由渲染层转手），
 * 而这一层原来是裸 `fs.copyFile(source, target)`：
 *   · 不 `lstat` → 源可以是**符号链接 / junction**，把校验想守的边界直接穿过去（P04）；
 *   · 不看类型 → 目录、设备文件、FIFO 都会试着拷；
 *   · 不设大小 → 一次拖一个 40GB 的镜像就把盘填满。
 *
 * ⚠️ 边界如实记：这条**不是**"只能从授权目录导入"—— 把外部文件拖进云盘本来
 * 就是它的用途（用户从桌面/下载目录拖东西）。它守的是"**源必须是一个真实存在的
 * 普通文件**"这条底线：符号链接与特殊文件一律拒（那是唯一能绕过"你看到的就是你
 * 拖的那个文件"这条直觉的东西）。
 *
 * @param raw 渲染进程给的源路径（**不可信**）
 * @returns 通过时给出 `realpath` 之后的路径
 */
async function validateImportSource(raw: string): Promise<{ ok: true; path: string } | { ok: false; why: string }> {
  const resolved = path.resolve(String(raw ?? ""));
  let stat;
  try {
    /* `lstat` 不跟随符号链接：链接本身不是"普通文件" → 直接拒 */
    stat = await fs.lstat(resolved);
  } catch {
    return { ok: false, why: "源文件不存在或读不了" };
  }
  if (stat.isSymbolicLink()) return { ok: false, why: "源是符号链接（不跟随 —— 审计 P04）" };
  if (!stat.isFile()) return { ok: false, why: "源不是普通文件" };
  if (stat.size > IMPORT_MAX_BYTES) {
    return { ok: false, why: `源超过上限 ${Math.round(IMPORT_MAX_BYTES / 1024 / 1024)}MB` };
  }
  /* realpath 之后拿到的才是"真的那个文件"（父目录里的链接在这一步被解开） */
  try {
    return { ok: true, path: await fs.realpath(resolved) };
  } catch {
    return { ok: false, why: "取不到真实路径" };
  }
}

/** 单个导入源的字节上限（拖一个几十 GB 的镜像进来不该把盘填满）。 */
const IMPORT_MAX_BYTES = 512 * 1024 * 1024;

export async function importPaths(sources: readonly string[]): Promise<ImportOutcome> {
  const dir = driveDir();
  await fs.mkdir(dir, { recursive: true });
  const items: ImportItem[] = [];
  let imported = 0;
  for (const source of sources) {
    const checked = await validateImportSource(source);
    if (!checked.ok) {
      /* ⚠️ `ImportItem.reason` 是**枚举**（上传统一话术），不是自由文本 —— 这里按类归 */
      items.push({ ok: false, name: path.basename(String(source ?? "")) || "(未命名)", reason: "parseFail" });
      continue;
    }
    const item = await putIntoDrive(dir, path.basename(checked.path), (target) => fs.copyFile(checked.path, target));
    if (item.ok) imported += 1;
    items.push(item);
  }
  return { imported, dir, items };
}

/**
 * 按**内容**导入（§171，拖拽走这条）。
 *
 * 为什么需要它：拖进来的文件在渲染进程那边是 `File` 对象，
 * **不一定拿得到磁盘路径**（Electron 里也能拿，但路径拿不到时不该就没办法了）。
 * 有内容就够了 —— 而且这条路**能被自动化验**（造一个真 `File` 就能走完）。
 *
 * @param items 名字 + 字节
 * @returns 与 `importPaths` 同一形状的结果
 */
export async function importData(
  items: Array<{ name: string; data: Uint8Array }>,
): Promise<ImportOutcome> {
  const dir = driveDir();
  await fs.mkdir(dir, { recursive: true });
  const out: ImportItem[] = [];
  let imported = 0;
  for (const item of items) {
    const got = await putIntoDrive(dir, path.basename(String(item?.name ?? "")), (target) =>
      fs.writeFile(target, Buffer.from(item.data)),
    );
    if (got.ok) imported += 1;
    out.push(got);
  }
  return { imported, dir, items: out };
}

export function registerDriveIpc(
  ipcMain: Electron.IpcMain,
  getWindow: () => Electron.BrowserWindow | null,
): void {
  ipcMain.handle(DRIVE_CHANNEL.list, (): Promise<DriveEntry[]> => listDrive());

  ipcMain.handle(DRIVE_CHANNEL.import, async (): Promise<ImportOutcome> => {
    const win = getWindow();
    const picked = win
      ? await dialog.showOpenDialog(win, {
          title: "导入到云盘",
          properties: ["openFile", "multiSelections"],
        })
      : await dialog.showOpenDialog({ properties: ["openFile", "multiSelections"] });
    if (picked.canceled || picked.filePaths.length === 0) return { imported: 0, dir: driveDir(), items: [] };
    return importPaths(picked.filePaths);
  });

  /*
   * 程序化导入（§170）：拖拽、批量、以及**验收**都走这条路 ——
   * 它与上面那个对话框入口**共用同一段实现**（不是两套）。
   */
  ipcMain.handle(DRIVE_CHANNEL.importPaths, async (_event, paths: unknown): Promise<ImportOutcome> =>
    importPaths(Array.isArray(paths) ? paths.filter((x): x is string => typeof x === "string") : []),
  );

  ipcMain.handle(DRIVE_CHANNEL.importData, async (_event, items: unknown): Promise<ImportOutcome> => {
    const list = Array.isArray(items) ? items : [];
    return importData(
      list
        .filter((x): x is { name: string; data: Uint8Array } => Boolean(x) && typeof x.name === "string")
        .map((x) => ({ name: x.name, data: new Uint8Array(x.data as unknown as ArrayBufferLike) })),
    );
  });

  /*
   * 新建文件夹（§157）。本体云盘的「新建文件夹」是个真目录；
   * 本机版的云盘目录是**平的**（不建层级），所以这里建目录只用于"有个地方放东西"，
   * 界面上如实说明不显示层级。
   */
  /*
   * 重命名（§158，`drive_menuOption_rename`）。
   * 只在同一目录内改名 —— 传进来的名字里带分隔符、或目标已存在，都直接拒掉。
   */
  /*
   * 下载 / 另存为（§169，`drive_menuOption_download`）。
   *
   * 只有一种用法：**弹系统「另存为」框，让用户挑地方**。
   *
   * ⚠️ 2026-10-16（审计 G21 里那条"被判已加锁"的漏项）：这里原来还有一个
   * `targetDir?: string` 参数 ——「给了就静默复制到这个目录」。
   * 那条路是**渲染进程定目录 + 主进程写盘**，而目录名不校验（只有源做过白名单判断），
   * 也就是把"任意目录写文件"这个原语交给了不可信的一侧，与紧挨着的
   * 「渲染进程给的东西一律按不可信处理」自相矛盾。
   *
   * 已经**整个删掉**了：全仓（含验收脚本）零调用方，注释里那句"验收里能确定性验的那条路"
   * 是过期的不实说法。要存到别处，用户自己在另存为框里挑 —— 那也是唯一天然可信的目录来源。
   *
   * ⚠️ 源文件仍**必须落在白名单目录里**（与 `dshasset://file/<origin>/<名字>` 同一条边界），
   * 否则这里就成了"任意文件读出"。
   */
  ipcMain.handle(
    DRIVE_CHANNEL.download,
    async (_event, filePath: string): Promise<{ ok: boolean; savedTo?: string; canceled?: boolean }> => {
      try {
        const src = path.resolve(String(filePath ?? ""));
        const inside = sources().some((s) => {
          const rel = path.relative(path.resolve(s.dir), src);
          return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
        });
        if (!inside) return { ok: false };
        const stat = await fs.stat(src);
        if (!stat.isFile()) return { ok: false };

        const picked = await dialog.showSaveDialog({
          title: "另存为",
          defaultPath: path.basename(src),
          buttonLabel: "保存",
        });
        // 用户点了取消：这不是失败，界面上要说"下载已取消"
        if (picked.canceled || !picked.filePath) return { ok: false, canceled: true };
        const dest = picked.filePath;

        await fs.copyFile(src, dest);
        return { ok: true, savedTo: dest };
      } catch {
        return { ok: false };
      }
    },
  );

  /*
   * 重命名（§158）。
   *
   * ⚠️ **A1：路径必须落在自己的来源目录里。**
   * 同文件的 `remove` / `duplicate` / `reveal` / `open` 一直走了 `insideOwnedDirs`，
   * 唯独它和下面的 `read` 漏了 —— 渲染进程传任意路径就能**改任意文件的文件名**。
   * 不通过时返回既有的失败值 `null`（**不抛异常**，调用方就是按 null 处理的）。
   *
   * 另外要求**源必须是一个普通文件**：`insideOwnedDirs` 对"目录自身"也放行，
   * 只加前者的话"把整个云盘目录改名搬走"会成为可能。云盘行本来就只列文件
   * （见 `listDir` 里的 `if (!stat.isFile()) continue`），所以这条不打断任何界面流程。
   */
  ipcMain.handle(DRIVE_CHANNEL.rename, async (_event, filePath: string, newName: string): Promise<string | null> => {
    const clean = String(newName ?? "").trim();
    if (!clean || /[\\/]/.test(clean)) return null;
    const from = insideOwnedDirs(filePath);
    if (!from) return null;
    try {
      const stat = await fs.stat(from);
      if (!stat.isFile()) return null;
      const dir = path.dirname(from);
      const to = path.join(dir, clean);
      // 目标已存在就不动（**不覆盖**）
      try {
        await fs.access(to);
        return null;
      } catch {
        /* 不存在才是正常的 */
      }
      await fs.rename(from, to);
      return clean;
    } catch {
      return null;
    }
  });

  /*
   * 读文本（§158，右键菜单里的「AI 阅读」要用）。
   * 超上限就返回 null —— 把几兆的东西塞进阅读面板只会把界面卡住。
   *
   * ⚠️ **A1：路径必须落在自己的来源目录里**（原来没有这道校验，
   * 渲染进程可以拿它读**任意** ≤200KB 的文本文件）。
   * 不通过同样返回既有的失败值 `null`；"超上限返回 null"的行为**原样保留**。
   */
  ipcMain.handle(DRIVE_CHANNEL.read, async (_event, filePath: string): Promise<string | null> => {
    const target = insideOwnedDirs(filePath);
    if (!target) return null;
    try {
      const stat = await fs.stat(target);
      if (!stat.isFile() || stat.size > READ_MAX_BYTES) return null;
      return await fs.readFile(target, "utf8");
    } catch {
      return null;
    }
  });

  ipcMain.handle(DRIVE_CHANNEL.mkdir, async (_event, name: string): Promise<string | null> => {
    const clean = String(name ?? "").trim();
    if (!clean || /[\\/]/.test(clean)) return null;
    try {
      await fs.mkdir(path.join(driveDir(), clean), { recursive: false });
      return clean;
    } catch {
      return null;
    }
  });
  ipcMain.handle(DRIVE_CHANNEL.remove, async (_event, filePath: string): Promise<boolean> => {
    const target = insideOwnedDirs(filePath);
    if (!target) return false;
    try {
      await fs.unlink(target);
      return true;
    } catch {
      return false;
    }
  });

  /**
   * 新建一个文件（对标云盘「＋新建」）。
   *
   * 建的是**真的空 Markdown 文件**，不是只弹一句话 ——
   * 原来那个按钮点了只给个提示，等于死按钮。
   *
   * 只允许建文本类：名称里带路径分隔符的一律拒掉（渲染进程给的东西按不可信处理）。
   */
  ipcMain.handle(
    DRIVE_CHANNEL.create,
    async (_event, rawName: string, rawContent: string): Promise<string | null> => {
      const name = String(rawName ?? "").trim();
      if (!name) return null;
      // 名字里不能有路径成分，也不能是 . 或 ..
      if (name !== path.basename(name) || name === "." || name === "..") return null;
      const finalName = /\.[A-Za-z0-9]{1,8}$/.test(name) ? name : `${name}.md`;
      const dir = driveDir();
      try {
        const unique = await uniqueName(dir, finalName);
        await fs.mkdir(dir, { recursive: true });
        await fs.writeFile(path.join(dir, unique), String(rawContent ?? ""), "utf8");
        return unique;
      } catch {
        return null;
      }
    },
  );

  /**
   * 创建副本（对标云盘行右键菜单里的「创建副本」）。
   *
   * 复制到**同一个目录**、名字加「-副本」；同名时再加序号。
   * 不做「复制到别的目录」—— 那需要一个目录选择器，属于另一个功能。
   */
  ipcMain.handle(DRIVE_CHANNEL.duplicate, async (_event, filePath: string): Promise<string | null> => {
    const target = insideOwnedDirs(filePath);
    if (!target) return null;
    const dir = path.dirname(target);
    const ext = path.extname(target);
    const stem = path.basename(target, ext);
    try {
      const name = await uniqueName(dir, `${stem}-副本${ext}`);
      await fs.copyFile(target, path.join(dir, name));
      return name;
    } catch {
      return null;
    }
  });

  ipcMain.handle(DRIVE_CHANNEL.reveal, (_event, filePath: string): boolean => {
    const target = insideOwnedDirs(filePath);
    if (!target) return false;
    shell.showItemInFolder(target);
    return true;
  });

  ipcMain.handle(DRIVE_CHANNEL.open, async (_event, filePath: string): Promise<string> => {
    const target = insideOwnedDirs(filePath);
    if (!target) return "这个文件不在云盘目录里";
    return (await shell.openPath(target)) || "";
  });
}

/**
 * 目录内不重名。同名时追加 `-2`、`-3`…
 *
 * @param dir 目录
 * @param name 期望文件名
 * @returns 可用的文件名
 */
async function uniqueName(dir: string, name: string): Promise<string> {
  const ext = path.extname(name);
  const stem = name.slice(0, name.length - ext.length);
  let candidate = name;
  for (let i = 2; i < 500; i += 1) {
    try {
      await fs.access(path.join(dir, candidate));
    } catch {
      return candidate;
    }
    candidate = `${stem}-${i}${ext}`;
  }
  return `${stem}-${Date.now()}${ext}`;
}
