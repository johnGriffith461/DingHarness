import path from "node:path";
import { describe, expect, it } from "vitest";

import { authorizeCwd, CwdNotAllowedError } from "./cwd";

/**
 * 工作目录授权判定（2026-10-16，审计 P168 / P195）。
 *
 * ## 这些断言要挡住的是什么
 *
 * 原来的判定是 `cwd.startsWith(dir)` —— **未规范化的字符串前缀**。它有两类漏：
 *   ① 兄弟前缀目录（`…\proj-evil` 以 `…\proj` 开头）被当成已授权；
 *   ② 带 `..` 的路径（`…\proj\..\..\Windows`）照过。
 * 每一条都可能把"能读写文件、能跑命令"的工具授权范围扩到任意目录。
 *
 * 下面每一条**故意改坏就会红**：把实现换回 `startsWith`，① 与 ② 立刻失败。
 */

const root = path.resolve("/work/proj");
const other = path.resolve("/work/other");

describe("authorizeCwd", () => {
  it("授权目录自身放行（与 drivePaths 的口径一致）", () => {
    expect(authorizeCwd(root, [root])).toEqual({ ok: true, cwd: root });
  });

  it("子目录放行，且给的是 resolve 后的绝对路径", () => {
    const inside = path.join(root, "sub", "deep");
    const got = authorizeCwd(path.join(root, "sub", "..", "sub", "deep"), [root]);
    expect(got).toEqual({ ok: true, cwd: inside });
  });

  it("⭐ 兄弟前缀目录拒绝（`proj-evil` 不在 `proj` 里）", () => {
    const sibling = `${root}-evil`;
    const got = authorizeCwd(sibling, [root]);
    expect(got.ok, "兄弟前缀目录竟然被当成已授权").toBe(false);
    if (!got.ok) expect(got.reason).toContain("授权范围");
  });

  it("⭐ `..` 逃逸拒绝", () => {
    const escape = path.join(root, "..", "..", "Windows");
    expect(authorizeCwd(escape, [root]).ok).toBe(false);
  });

  it("多目录白名单：命中任意一个都算过", () => {
    const inOther = path.join(other, "x");
    expect(authorizeCwd(inOther, [root, other])).toEqual({ ok: true, cwd: inOther });
    expect(authorizeCwd(inOther, [root]).ok).toBe(false);
  });

  it("相对路径拒绝（外部宿主传的 cwd 必须绝对）", () => {
    expect(authorizeCwd("proj/sub", [root]).ok).toBe(false);
    expect(authorizeCwd("", [root]).ok).toBe(false);
  });

  it("⭐ 目录名以 `..` 开头但在里面（`..foo`）要放行 —— 判定看的是完整路径段", () => {
    /*
     * `path.relative(root, root + "\\..foo")` 是 `"..foo"`，
     * 谁把实现写成 `rel.startsWith("..")` 就会**错杀**这个子目录。
     */
    const dotted = path.join(root, "..foo");
    expect(authorizeCwd(dotted, [root])).toEqual({ ok: true, cwd: dotted });
  });

  it("拒绝时给一句话（带可用目录），能直接展示给调用方", () => {
    const got = authorizeCwd(other, [root]);
    expect(got.ok).toBe(false);
    if (!got.ok) expect(got.reason).toContain(root);
  });

  it("CwdNotAllowedError 是带名字的 Error（服务层按它翻 400，不靠文案认）", () => {
    const error = new CwdNotAllowedError("不在授权范围");
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("CwdNotAllowedError");
    expect(error.message).toBe("不在授权范围");
  });
});
