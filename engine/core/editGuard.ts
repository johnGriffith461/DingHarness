/**
 * B-01：「接受编辑」档的路径守卫（**唯一实现**）。
 *
 * ## 为什么单独一层
 *
 * 这一档要回答的问题比"工具是读还是写"细一档：**这次写的是哪个路径**。
 * 判定在 `engine/core/policy.ts`（`applyEditMode`），而"哪些路径永远不自动放行"
 * 与"这个路径在不在工作区里"必须只有一份 —— policy 与宿主都调这里，
 * 否则 CLI 与桌面迟早在 `.env` 该不该问上分叉。
 *
 * ## 为什么不用 `node:path`
 *
 * `engine/core` 在**最小嵌入面**的 import 闭包里，而那条闭包**禁止 `node:*`**
 * （见 `src/engineCoreBoundary.test.ts`）。所以路径规范化在这里是纯字符串实现：
 * 分隔符统一、`.`/`..` 折叠、盘符大写。够用来回答"在不在工作区/是不是保护路径"，
 * 不需要文件系统。
 */

/** 三个会写用户文件的工具（`apply_patch` 一次可能写多个）。 */
export function isEditToolName(name: string): boolean {
  return name === "write_file" || name === "edit_file" || name === "apply_patch";
}

/** 任何一层出现在路径里都不自动放行的目录（大小写不敏感）。 */
const PROTECTED_DIRS = new Set([".git", ".ssh", "node_modules"]);

/**
 * 纯字符串规范化：`\` → `/`、去掉空段与 `.`、折叠 `..`、盘符大写。
 *
 * @returns 规范化后的路径；**越界（`..` 逃出起点）或空串返回 `null`**
 */
export function normalizePath(raw: string): string | null {
  const text = String(raw ?? "").trim().replace(/\\/g, "/");
  if (!text) return null;
  const drive = /^([a-zA-Z]):\//.exec(text);
  const absolute = text.startsWith("/") || Boolean(drive);
  const rest = drive ? text.slice(drive[0].length) : text.startsWith("/") ? text.slice(1) : text;
  const parts: string[] = [];
  for (const segment of rest.split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      if (!parts.length) return null; // 逃出起点：相对路径会跑到工作区外，绝对路径会跑到根外
      parts.pop();
      continue;
    }
    parts.push(segment);
  }
  const joined = parts.join("/");
  if (drive) return `${drive[1]!.toUpperCase()}:/${joined}`.replace(/\/$/, "");
  if (absolute) return `/${joined}`.replace(/\/$/, "") || "/";
  return joined;
}

/**
 * 这个路径是否**永远需要确认**。
 *
 * 覆盖（方案原文）：`.git/`、`.env`、`.env.*`、`.ssh/`、`node_modules/`、`..` 逃逸。
 * 空串也算保护 —— "说不清是哪个文件"时问一次比猜安全。
 *
 * ⚠️ `.gitignore` **不**算：`.git` 必须是完整的一段目录名。
 */
export function isProtectedPath(raw: string): boolean {
  const normalized = normalizePath(raw);
  if (!normalized) return true;
  const segments = normalized.split("/").filter(Boolean);
  for (const segment of segments) {
    if (PROTECTED_DIRS.has(segment.toLowerCase())) return true;
  }
  const base = (segments[segments.length - 1] ?? "").toLowerCase();
  return base === ".env" || base.startsWith(".env.");
}

/** 两个已规范化路径里是否有一个像 Windows 盘符路径（大小写不敏感比较只对它成立）。 */
function windowsLike(a: string, b: string): boolean {
  return /^[A-Za-z]:\//.test(a) || /^[A-Za-z]:\//.test(b);
}

/**
 * 目标路径是否落在某个授权目录里。
 *
 * - 相对路径按**第一个**授权目录解析（与 `run_command` 的 workdir 口径一致）；
 * - 绝对路径直接比对；
 * - 没有授权目录 → `false`（说不清就确认，而不是放行）。
 */
export function isInsideWorkspace(raw: string, workdirs: readonly string[]): boolean {
  const target = normalizePath(raw);
  if (!target || !workdirs.length) return false;
  const absolute = target.startsWith("/") || /^[A-Za-z]:\//.test(target);
  const candidates: string[] = [];
  if (absolute) {
    candidates.push(target);
  } else {
    const base = normalizePath(workdirs[0] ?? "");
    if (!base) return false;
    const joined = normalizePath(`${base}/${target}`);
    if (joined) candidates.push(joined);
  }
  return workdirs.some((dir) => {
    const root = normalizePath(dir);
    if (!root) return false;
    return candidates.some((candidate) => {
      const [a, b] = windowsLike(candidate, root) ? [candidate.toLowerCase(), root.toLowerCase()] : [candidate, root];
      return a === b || a.startsWith(`${b.replace(/\/$/, "")}/`);
    });
  });
}

/**
 * 从一次编辑调用里取出**它要写的所有路径**。
 *
 * `apply_patch` 的路径藏在补丁文本里（`*** Add|Update|Delete File: <路径>`）；
 * 解析不出就是空数组 —— 调用方据此仍然确认（**不放行来路不明的补丁**）。
 */
export function pathsOfEdit(name: string, input: unknown): string[] {
  if (!isEditToolName(name)) return [];
  const obj = (input ?? {}) as Record<string, unknown>;
  if (name === "apply_patch") {
    const text = typeof obj.patchText === "string" ? obj.patchText : "";
    const out: string[] = [];
    for (const line of text.split(/\r?\n/)) {
      const matched = /^\*\*\* (?:Add|Update|Delete) File: (.+)$/.exec(line.trim());
      const file = matched?.[1]?.trim();
      if (file) out.push(file);
    }
    return out;
  }
  return typeof obj.path === "string" ? [obj.path] : [];
}
