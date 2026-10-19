import fs from "node:fs/promises";
import path from "node:path";

/**
 * 编辑格式（D3）：整文件 / 精确替换 / `apply_patch`。
 *
 * 补丁格式照 Codex 的 `*** Begin Patch`（只借格式，不复制实现）：
 *
 * ```
 * *** Begin Patch
 * *** Add File: src/a.ts
 * +内容
 * *** Update File: src/b.ts
 * @@
 * -旧行
 * +新行
 * *** Delete File: src/c.ts
 * *** End Patch
 * ```
 *
 * 解析失败给**行号**，不写任何文件 —— 半个补丁落盘比不改更糟。
 */

export type EditFormat = "search_replace" | "apply_patch" | "whole_file";

export type PatchOp =
  | { kind: "add"; path: string; content: string }
  | { kind: "delete"; path: string }
  | { kind: "update"; path: string; hunks: Array<{ oldText: string; newText: string }> };

/** 按模型选格式；未知一律精确替换（与现有 `edit_file` 一致，不赌）。 */
export function editFormatFor(_modelId: string): EditFormat {
  return "search_replace";
}

const BEGIN = "*** Begin Patch";
const END = "*** End Patch";
const ADD = "*** Add File: ";
const DELETE = "*** Delete File: ";
const UPDATE = "*** Update File: ";

type ParseResult = { ok: true; ops: PatchOp[] } | { ok: false; error: string; line?: number };

/**
 * 解析补丁文本。
 *
 * @param text 模型给的补丁
 */
export function parsePatch(text: string): ParseResult {
  const lines = String(text ?? "").split(/\r?\n/);
  const begin = lines.findIndex((line) => line.trim() === BEGIN);
  if (begin < 0) return { ok: false, error: `补丁缺少开头标记「${BEGIN}」` };
  const end = lines.findIndex((line, i) => i > begin && line.trim() === END);
  if (end < 0) return { ok: false, error: `补丁缺少结尾标记「${END}」` };

  const ops: PatchOp[] = [];
  let i = begin + 1;
  while (i < end) {
    const line = lines[i] ?? "";
    if (!line.trim()) {
      i += 1;
      continue;
    }
    if (line.startsWith(ADD)) {
      const file = line.slice(ADD.length).trim();
      if (!file) return { ok: false, error: "Add File 没写路径", line: i + 1 };
      const body: string[] = [];
      i += 1;
      while (i < end && !/^\*\*\* (Add|Update|Delete) File: /.test(lines[i] ?? "")) {
        const row = lines[i] ?? "";
        if (row.startsWith("+")) body.push(row.slice(1));
        else if (row.trim() === "") body.push("");
        else return { ok: false, error: "Add File 的内容行必须以 + 开头", line: i + 1 };
        i += 1;
      }
      ops.push({ kind: "add", path: file, content: body.join("\n") });
      continue;
    }
    if (line.startsWith(DELETE)) {
      const file = line.slice(DELETE.length).trim();
      if (!file) return { ok: false, error: "Delete File 没写路径", line: i + 1 };
      ops.push({ kind: "delete", path: file });
      i += 1;
      continue;
    }
    if (line.startsWith(UPDATE)) {
      const file = line.slice(UPDATE.length).trim();
      if (!file) return { ok: false, error: "Update File 没写路径", line: i + 1 };
      const hunks: Array<{ oldText: string; newText: string }> = [];
      i += 1;
      while (i < end && !/^\*\*\* (Add|Update|Delete) File: /.test(lines[i] ?? "")) {
        const row = lines[i] ?? "";
        /* `@@` 是 hunk 分隔；后面若带上下文标题忽略（我们按行精确匹配） */
        if (row.startsWith("@@")) {
          const oldLines: string[] = [];
          const newLines: string[] = [];
          i += 1;
          while (i < end && !/^@@|^\*\*\* (Add|Update|Delete) File: /.test(lines[i] ?? "")) {
            const body = lines[i] ?? "";
            if (body.startsWith("+")) newLines.push(body.slice(1));
            else if (body.startsWith("-")) oldLines.push(body.slice(1));
            else if (body.startsWith(" ")) {
              oldLines.push(body.slice(1));
              newLines.push(body.slice(1));
            } else if (body.trim() === "") {
              /* 空行：两边都算（补丁里的裸空行通常是上下文） */
              oldLines.push("");
              newLines.push("");
            } else {
              return { ok: false, error: "补丁行必须以 + / - / 空格 开头", line: i + 1 };
            }
            i += 1;
          }
          if (!oldLines.length && !newLines.length) {
            return { ok: false, error: "空的补丁段", line: i };
          }
          hunks.push({ oldText: oldLines.join("\n"), newText: newLines.join("\n") });
          continue;
        }
        if (!row.trim()) {
          i += 1;
          continue;
        }
        return { ok: false, error: `Update File 里出现了无法识别的行：${row.slice(0, 40)}`, line: i + 1 };
      }
      if (!hunks.length) return { ok: false, error: `Update File 没有任何 @@ 段：${file}` };
      ops.push({ kind: "update", path: file, hunks });
      continue;
    }
    return { ok: false, error: `无法识别的补丁行：${line.slice(0, 40)}`, line: i + 1 };
  }

  if (!ops.length) return { ok: false, error: "补丁里没有任何操作" };
  return { ok: true, ops };
}

/**
 * 应用补丁。
 *
 * @param root 工作区根（`restrictToCwd` 时所有路径必须落在它下面）
 * @param ops 解析结果
 * @param opts.resolvePath 宿主提供的路径白名单解析（与写工具同一道）
 */
export async function applyPatch(
  root: string,
  ops: readonly PatchOp[],
  opts: { restrictToCwd: boolean; resolvePath: (p: string) => string | null },
): Promise<{ ok: boolean; changed: string[]; error?: string }> {
  /* 先全部解析一遍：任何一条越界/不存在都在**动手前**失败，不留半个补丁 */
  const plan: Array<{ op: PatchOp; target: string }> = [];
  for (const op of ops) {
    const target = opts.resolvePath(op.path);
    if (!target) return { ok: false, changed: [], error: `路径不在可改范围内：${op.path}` };
    if (opts.restrictToCwd) {
      const rel = path.relative(path.resolve(root), path.resolve(target));
      if (rel.startsWith("..") || path.isAbsolute(rel)) {
        return { ok: false, changed: [], error: `路径逃出了工作区：${op.path}` };
      }
    }
    plan.push({ op, target });
  }

  const changed: string[] = [];
  for (const { op, target } of plan) {
    if (op.kind === "add") {
      try {
        await fs.access(target);
        return { ok: false, changed, error: `Add File 的目标已存在：${op.path}` };
      } catch {
        /* 不存在才是对的 */
      }
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, op.content, "utf8");
      changed.push(op.path);
      continue;
    }
    if (op.kind === "delete") {
      try {
        await fs.unlink(target);
        changed.push(op.path);
      } catch (error) {
        return { ok: false, changed, error: `删不掉 ${op.path}：${error instanceof Error ? error.message : String(error)}` };
      }
      continue;
    }
    let source: string;
    try {
      source = await fs.readFile(target, "utf8");
    } catch {
      return { ok: false, changed, error: `Update File 的文件读不到：${op.path}` };
    }
    const eol = source.includes("\r\n") ? "\r\n" : "\n";
    let next = source.replace(/\r\n/g, "\n");
    for (const hunk of op.hunks) {
      const oldText = hunk.oldText.replace(/\r\n/g, "\n");
      const newText = hunk.newText.replace(/\r\n/g, "\n");
      const hits = next.split(oldText).length - 1;
      if (hits === 0) return { ok: false, changed, error: `Update File 找不到要改的原文：${op.path}` };
      if (hits > 1) return { ok: false, changed, error: `Update File 的原文命中 ${hits} 处（要求唯一）：${op.path}` };
      next = next.replace(oldText, newText);
    }
    await fs.writeFile(target, eol === "\r\n" ? next.replace(/\n/g, "\r\n") : next, "utf8");
    changed.push(op.path);
  }
  return { ok: true, changed };
}
