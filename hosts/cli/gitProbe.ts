import { mkdtempSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";

/**
 * 这台机器上的 `git` **真的能用**吗？（跨平台真机验证抓到的）
 *
 * ⚠️ 2026-10-18（macOS 26.7.1 真机）：没有 Xcode 命令行工具的 macOS 上，
 * `/usr/bin/git` 只是一个会弹"请安装开发者工具"的**桩**：任何 `git init` 都会失败并打印
 * `xcode-select: note: No developer tools were found…`。
 * 那些用例验的是**产品的 git 封装**（记忆镜像 / worktree），不是"这台机器装没装 git" ——
 * 没装就把它们**跳过并写明原因**，而不是红成"产品坏了"，也不是静默跳过。
 *
 * 判据不只看 `git --version`（桩也会返回 0），而是**真跑一次 `git init`**。
 */
export const GIT_USABLE = (() => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "dh-git-probe-"));
  try {
    const res = spawnSync("git", ["init", "-q"], { cwd: dir, encoding: "utf8", timeout: 20_000 });
    return res.status === 0;
  } catch {
    return false;
  } finally {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* 尽力而为 */
    }
  }
})();

/** 跳过时给的那句话（写在 `it.skipIf` 旁边，与这里同一口径）。 */
export const GIT_SKIP_REASON =
  "这台机器上没有可用的 git（macOS 未装 Xcode 命令行工具时 /usr/bin/git 是桩）—— 跳过，不是通过";
