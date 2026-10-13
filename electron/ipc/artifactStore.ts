import { app, shell } from "electron";
import fs from "node:fs/promises";
import path from "node:path";
import { markdownToOffice } from "./officeWrite";

/**
 * 对话产物落盘（阶段 11.1）。
 *
 * 原版的产物是**真文件**：右侧「对话产物」点开能看、能下载。所以这里不是把正文
 * 存在渲染进程的内存里，而是写到磁盘上的一个固定目录，再把路径交回界面。
 *
 * 目录：`<userData>/artifacts/`
 *   · 放在 userData 下，跟着应用数据走，卸载/清理时行为可预期；
 *   · 文件名由渲染进程按「标题 + 类型扩展名」给出（见 `artifactFileName`），
 *     **这里仍然要再校验一遍** —— 渲染进程给的名字不能直接信。
 */

/** 通道名。 */
export const ARTIFACT_CHANNEL = {
  save: "artifact:save",
  open: "artifact:open",
  reveal: "artifact:reveal",
  list: "artifact:list",
} as const;

/** 产物目录。 */
function artifactsDir(): string {
  return path.join(app.getPath("userData"), "artifacts");
}

/**
 * 把渲染进程给的文件名压成安全的单段文件名。
 *
 * 渲染进程那边的 `artifactFileName` 已经处理过一遍，这里是**第二道**：
 * 跨进程传进来的东西要按不可信处理。只留基名、挡掉 `.`/`..`、限制字符集。
 *
 * @param raw 渲染进程给的文件名
 * @returns 安全文件名；不可用时退成 `artifact.bin`
 */
export function sanitizeName(raw: string): string {
  const base = path.basename(String(raw ?? "").replace(/\\/g, "/"));
  const cleaned = base
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "-")
    .replace(/^\.+/, "")
    .trim();
  if (!cleaned || cleaned === "." || cleaned === "..") return "artifact.bin";
  return cleaned.slice(0, 80);
}

/**
 * 目录内不重名。同名时追加 `-2`、`-3`…
 *
 * @param dir 目录
 * @param name 期望文件名
 * @returns 实际可用的文件名
 */
async function uniqueName(dir: string, name: string): Promise<string> {
  const ext = path.extname(name);
  const stem = name.slice(0, name.length - ext.length);
  let candidate = name;
  for (let i = 2; i < 500; i += 1) {
    try {
      await fs.access(path.join(dir, candidate));
    } catch {
      return candidate; // 不存在 → 可用
    }
    candidate = `${stem}-${i}${ext}`;
  }
  return `${stem}-${Date.now()}${ext}`;
}

/**
 * 保存结果。
 *
 * `generated` 说明这次是不是**真的构造了目标格式**（而不是把 Markdown 原样写进去）。
 */
export type ArtifactSaved = {
  filePath: string;
  name: string;
  bytes: number;
  generated?: boolean;
  /** 目标格式生成失败时的降级说明（界面可以显示出来）。 */
  note?: string;
};

/**
 * Office 三类的目标格式。
 *
 * 判断依据是**扩展名**：渲染进程给的 `artifactFileName` 里已经带上了
 * `.docx/.pptx/.xlsx`，这里据此决定走不走生成器。
 */
function officeKindOf(name: string): "docx" | "pptx" | "xlsx" | null {
  const ext = path.extname(name).toLowerCase();
  if (ext === ".docx") return "docx";
  if (ext === ".pptx") return "pptx";
  if (ext === ".xlsx") return "xlsx";
  return null;
}

/**
 * 注册产物相关的 IPC。
 *
 * @param ipcMain Electron 的 ipcMain
 */
export function registerArtifactIpc(ipcMain: Electron.IpcMain): void {
  ipcMain.handle(
    ARTIFACT_CHANNEL.save,
    async (_event, name: string, data: Uint8Array | string): Promise<ArtifactSaved> => {
      const dir = artifactsDir();
      await fs.mkdir(dir, { recursive: true });
      const cleanName = sanitizeName(name);
      const isText = typeof data === "string";

      /*
       * 目标是 Office 格式、而渲染进程给的是 Markdown 文本 → **真的构造格式**。
       *
       * 不做这一步就会往 .docx 里写 Markdown，产出一个"看起来成功、打开是坏的"文件。
       * 生成失败时退回落成 .md 并在 note 里说清 —— 不假装成功。
       */
      const office = isText ? officeKindOf(cleanName) : null;
      if (office) {
        try {
          const title = cleanName.replace(/\.[^.]+$/, "");
          const buffer = await markdownToOffice(office, String(data), title);
          const finalName = await uniqueName(dir, cleanName);
          const target = path.join(dir, finalName);
          await fs.writeFile(target, buffer);
          return { filePath: target, name: finalName, bytes: buffer.byteLength, generated: true };
        } catch (error) {
          const fallback = `${cleanName.replace(/\.[^.]+$/, "")}.md`;
          const finalName = await uniqueName(dir, sanitizeName(fallback));
          const target = path.join(dir, finalName);
          const buffer = Buffer.from(String(data), "utf8");
          await fs.writeFile(target, buffer);
          return {
            filePath: target,
            name: finalName,
            bytes: buffer.byteLength,
            generated: false,
            note: `${office} 生成失败，已改存为 Markdown：${error instanceof Error ? error.message : String(error)}`,
          };
        }
      }

      const finalName = await uniqueName(dir, cleanName);
      const target = path.join(dir, finalName);
      const buffer = isText ? Buffer.from(String(data), "utf8") : Buffer.from(data as Uint8Array);
      await fs.writeFile(target, buffer);
      return { filePath: target, name: finalName, bytes: buffer.byteLength };
    },
  );

  ipcMain.handle(ARTIFACT_CHANNEL.open, async (_event, filePath: string): Promise<string> => {
    const target = safeExisting(filePath);
    if (!target) return "产物不存在";
    const error = await shell.openPath(target);
    return error || "";
  });

  ipcMain.handle(ARTIFACT_CHANNEL.reveal, async (_event, filePath: string): Promise<boolean> => {
    const target = safeExisting(filePath);
    if (!target) return false;
    shell.showItemInFolder(target);
    return true;
  });

  ipcMain.handle(ARTIFACT_CHANNEL.list, async (): Promise<ArtifactSaved[]> => {
    const dir = artifactsDir();
    try {
      const names = await fs.readdir(dir);
      const out: ArtifactSaved[] = [];
      for (const name of names) {
        const full = path.join(dir, name);
        const stat = await fs.stat(full).catch(() => null);
        if (stat?.isFile()) out.push({ filePath: full, name, bytes: stat.size });
      }
      return out;
    } catch {
      return []; // 目录还没建过 = 没有任何产物
    }
  });
}

/**
 * 校验路径确实是我们产物目录下的已存在文件。
 *
 * 不这么做的话，渲染进程传一个任意路径进来就能让主进程打开/定位它 ——
 * 这是跨进程边界上必须挡的一手。
 *
 * @param filePath 渲染进程给的路径
 * @returns 通过校验的绝对路径；不通过返回 null
 */
function safeExisting(filePath: string): string | null {
  const dir = artifactsDir();
  const resolved = path.resolve(String(filePath ?? ""));
  const rel = path.relative(dir, resolved);
  // 必须真的落在产物目录里（`..` 开头表示跑出去了）
  if (rel.startsWith("..") || path.isAbsolute(rel)) return null;
  return resolved;
}

/** 给别处（比如打包自检）用的目录读取。 */
export function artifactsPath(): string {
  return artifactsDir();
}
