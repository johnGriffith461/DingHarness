import path from "node:path";

/**
 * 工作目录授权判定（2026-10-16，审计 P168 / P195 / P181）。
 *
 * ## 为什么单独一个文件
 *
 * 原来这份判断在两处各写了一遍，而且写的是**未规范化的字符串前缀**：
 *
 * ```ts
 * const allowed = dirs.filter((d) => cwd.startsWith(d));   // ❌
 * ```
 *
 * 它有两个洞、一个谎：
 *   · `C:\work\proj-evil` 以 `C:\work\proj` 开头 → **兄弟前缀目录被当成已授权**；
 *   · 不 `resolve`，`C:\work\proj\..\..\Windows` 这类带 `..` 的路径照过；
 *   · 不通过时**静默落回默认目录**（调用方不知道自己的 cwd 被换了）。
 *
 * 这个文件只做一件事：**resolve 之后按路径段判定归属**，不通过就**明确拒绝**
 * （由调用方翻成 400 / JSON-RPC error，而不是悄悄改用别的目录）。
 *
 * ⚠️ 判定用 `path.relative`，于是 Windows 的大小写不敏感、盘符与 UNC 的差异
 * 都由 Node 统一处理 —— 不自己拼字符串比。
 *
 * ⚠️ 注意别写回 `rel.startsWith("..")`：目录里叫 `..foo` 的子目录会命中那个前缀
 * 而被**错杀**。要看的是 `..` 是不是一个**完整的路径段**（`..\x` / `..` 本身）。
 */

/** 授权判定的结论。不给「落回默认」这一态 —— 被拒绝就是被拒绝。 */
export type CwdDecision = { ok: true; cwd: string } | { ok: false; reason: string };

/**
 * 判一个客户端给的工作目录能不能用。
 *
 * @param raw 客户端给的 cwd（**不可信**：来自请求体 / JSON-RPC）
 * @param dirs 授权目录白名单（绝对路径）
 * @returns 通过时给 **resolve 之后**的路径；不通过给一句能直接展示的原因
 */
export function authorizeCwd(raw: string, dirs: readonly string[]): CwdDecision {
  const value = String(raw ?? "").trim();
  if (!value) return { ok: false, reason: "要一个非空的工作目录（cwd）" };
  if (!path.isAbsolute(value)) return { ok: false, reason: `工作目录要绝对路径：${value}` };
  const resolved = path.resolve(value);

  for (const dir of dirs) {
    const root = path.resolve(String(dir ?? ""));
    const rel = path.relative(root, resolved);
    /* `rel === ""` 即"目录自身"（与 drivePaths 的口径一致：自身放行） */
    if (rel === "") return { ok: true, cwd: resolved };
    if (rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) continue;
    return { ok: true, cwd: resolved };
  }
  const list = dirs.length ? dirs.map((d) => path.resolve(String(d))).join(" / ") : "（一个授权目录都没有）";
  return { ok: false, reason: `工作目录不在授权范围内：${resolved}（可用：${list}）` };
}

/**
 * 「这个 cwd 没被授权」这件事**带类型**地穿过调用栈。
 *
 * 服务层要按它回 400（而不是 500）：请求有问题，不是服务坏了。
 * 只靠 message 里带关键字来辨认，会让一句文案改动就悄悄把 400 变成 500。
 */
export class CwdNotAllowedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CwdNotAllowedError";
  }
}
