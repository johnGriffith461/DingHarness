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

/** 文件名总长上限（含扩展名）。 */
export const ARTIFACT_MAX_NAME = 80;

/**
 * Office 生成前的正文长度上限（**审计 P227**）。
 *
 * `.docx/.pptx/.xlsx` 的整包构造跑在主进程（单线程）：几千行表格或几万字长文
 * 会把所有窗口的输入与其它 IPC 一起卡住。这道上限拦住"异常超大"的输入，
 * 超限**不静默**——截断量会写进返回的 `note`，界面能显示出来。
 */
export const OFFICE_MAX_CHARS = 200_000;

/**
 * 给 Office 生成器截一道长度上限。
 *
 * @param text 原始正文
 * @returns 截断后的正文，以及超限时的降级说明（没超则 `note` 为 undefined）
 */
export function capOfficeText(text: string): { body: string; note?: string } {
  if (text.length <= OFFICE_MAX_CHARS) return { body: text };
  let end = OFFICE_MAX_CHARS;
  // 别把代理对切成半个（结尾落在高位代理上就退一格）
  const code = text.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end -= 1;
  return {
    body: text.slice(0, end),
    note: `正文 ${text.length} 字超过上限 ${OFFICE_MAX_CHARS} 字，已截断后生成`,
  };
}

/**
 * 把渲染进程给的文件名压成安全的单段文件名。
 *
 * 渲染进程那边的 `artifactFileName` 已经处理过一遍，这里是**第二道**：
 * 跨进程传进来的东西要按不可信处理。只留基名、挡掉 `.`/`..`、限制字符集。
 *
 * ⚠️ **审计 P225**：超长时**先留扩展名再截主名**。原来 `cleaned.slice(0, 80)`
 * 连扩展名一起截 —— 标题超过约 74 字时 `.docx/.pptx/.xlsx/.md` 被截掉，
 * `officeKindOf` 于是返回 null，Office 分支整个不走，Markdown 原文被写进一个
 * **没有扩展名**的产物文件（界面按成功显示）。
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
  if (cleaned.length <= ARTIFACT_MAX_NAME) return cleaned;
  const ext = path.extname(cleaned);
  // 没有扩展名，或扩展名本身就超长 → 只能硬截（此时保不住格式，如实退化）
  if (!ext || ext.length >= ARTIFACT_MAX_NAME) return cleaned.slice(0, ARTIFACT_MAX_NAME);
  const stem = cleaned.slice(0, cleaned.length - ext.length);
  return `${stem.slice(0, ARTIFACT_MAX_NAME - ext.length)}${ext}`;
}

/**
 * 独占创建写文件：**先真的占住名字**，再写内容（**审计 P224**）。
 *
 * 原来的 `uniqueName` 是"`fs.access` 探测 + 之后 `fs.writeFile`"：探测与写之间隔着
 * 一个 await，并发保存时两个调用都判定 `x.md` 不存在、都拿到同一个名字，
 * 后写的把先写的整份覆盖掉，而两边返回的 `filePath` 指向同一个文件
 * （用户以为存了两份，磁盘上只有一份）。`fs.open(…, "wx")` 由操作系统保证
 * "不存在才创建"，`EEXIST` 就换下一个候选 —— 竞态下也各得一份。
 *
 * @param dir 目录
 * @param name 期望文件名
 * @param data 文件内容
 * @returns 真正写成的文件名
 */
async function writeExclusive(dir: string, name: string, data: Uint8Array): Promise<string> {
  const ext = path.extname(name);
  const stem = name.slice(0, name.length - ext.length);
  for (let i = 1; i < 500; i += 1) {
    const candidate = i === 1 ? name : `${stem}-${i}${ext}`;
    try {
      const handle = await fs.open(path.join(dir, candidate), "wx");
      try {
        await handle.writeFile(data);
      } finally {
        await handle.close();
      }
      return candidate;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
  const fallback = `${stem}-${Date.now()}${ext}`;
  const handle = await fs.open(path.join(dir, fallback), "wx");
  try {
    await handle.writeFile(data);
  } finally {
    await handle.close();
  }
  return fallback;
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
        /* P227：超长正文先截断（截断量进 note，不静默） */
        const capped = capOfficeText(String(data));
        try {
          const title = cleanName.replace(/\.[^.]+$/, "");
          const buffer = await markdownToOffice(office, capped.body, title);
          const finalName = await writeExclusive(dir, cleanName, buffer);
          return {
            filePath: path.join(dir, finalName),
            name: finalName,
            bytes: buffer.byteLength,
            generated: true,
            ...(capped.note ? { note: capped.note } : {}),
          };
        } catch (error) {
          const fallback = `${cleanName.replace(/\.[^.]+$/, "")}.md`;
          const buffer = Buffer.from(capped.body, "utf8");
          const finalName = await writeExclusive(dir, sanitizeName(fallback), buffer);
          const reason = error instanceof Error ? error.message : String(error);
          const degrade = `${office} 生成失败，已改存为 Markdown：${reason}`;
          return {
            filePath: path.join(dir, finalName),
            name: finalName,
            bytes: buffer.byteLength,
            generated: false,
            note: capped.note ? `${degrade}；${capped.note}` : degrade,
          };
        }
      }

      const buffer = isText ? Buffer.from(String(data), "utf8") : Buffer.from(data as Uint8Array);
      const finalName = await writeExclusive(dir, cleanName, buffer);
      return { filePath: path.join(dir, finalName), name: finalName, bytes: buffer.byteLength };
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
