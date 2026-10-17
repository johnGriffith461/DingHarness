import { ipcMain } from "electron";
import fs from "node:fs/promises";
import path from "node:path";

import { fileChangesFrom, groupByPath, rollbackOf, summarizeChanges } from "../../engine/runtime/fileReview";
import { editFileForModel } from "../../engine/runtime/tools/editTool";
import { insideDirs } from "../../engine/runtime/tools/drivePaths";
import { ownedDirs } from "./driveStore";
import { desktopSessionStore } from "./sessionStore";

/**
 * **逐文件改动审阅的 IPC**（U08 桌面那一半，2026-10-18）。
 *
 * 能力本体在 `engine/runtime/fileReview.ts`（纯逻辑，有单测）；这里只做两件事：
 *   · 从**桌面的会话库**读日志、还原改动清单；
 *   · 回滚时把动作落到磁盘上（路径校验与写工具同一道 `insideDirs` 白名单）。
 *
 * ⚠️ 回滚**不是"撤销一切"**：它与 CLI 那条路同一套口径 —— `edit_file` 反向替换、
 * `write_file` 只在新建时可删；覆盖写没有原件，如实拒绝。
 */

export const REVIEW_CHANNEL = {
  list: "review:list",
  revert: "review:revert",
} as const;

/** 一次回滚的结果（IPC 的形状）。 */
export type RevertResult = { ok: true; reverted: number } | { ok: false; error: string };

/**
 * 注册审阅通道。
 *
 * @param ipc `ipcMain`（注入是为了与其它模块同一套测试/装配方式）
 */
export function registerReviewIpc(ipc: Pick<typeof ipcMain, "handle">): void {
  ipc.handle(REVIEW_CHANNEL.list, async (_event, sessionId: unknown) => {
    if (typeof sessionId !== "string" || !sessionId.trim()) {
      return { ok: false as const, error: "没有给会话 id" };
    }
    const loaded = await desktopSessionStore().load(sessionId);
    if (loaded.denied) return { ok: false as const, error: "没有可给你的内容（这段会话不属于当前身份）" };
    const changes = fileChangesFrom(loaded.records);
    /*
     * 渲染层要的是"按文件分组 + 统计"，而 `before/after` 只用于画 diff ——
     * 这里原样带上（编辑段落本来就不长；真要很长时界面只画前 60 行）。
     */
    return {
      ok: true as const,
      summary: summarizeChanges(changes),
      files: groupByPath(changes),
    };
  });

  ipc.handle(REVIEW_CHANNEL.revert, async (_event, sessionId: unknown, target: unknown): Promise<RevertResult> => {
    if (typeof sessionId !== "string" || typeof target !== "string" || !target.trim()) {
      return { ok: false, error: "参数不完整（要会话 id 与文件路径）" };
    }
    const loaded = await desktopSessionStore().load(sessionId);
    if (loaded.denied) return { ok: false, error: "没有可给你的内容（这段会话不属于当前身份）" };
    const groups = groupByPath(fileChangesFrom(loaded.records));
    const group = groups.find((g) => g.path === target || path.basename(g.path) === target);
    if (!group) return { ok: false, error: `这段会话没有改过「${target}」` };

    const dirs = ownedDirs();
    let reverted = 0;
    /*
     * 从**最后一条**开始：同一个文件改了多次时，逆序才能回到最初的样子
     * （先回滚最后一次的 new→old，再回滚前一次的）。
     */
    for (const change of [...group.changes].reverse()) {
      const action = rollbackOf(change);
      if (action.kind === "impossible") return { ok: false, error: `${change.path}：${action.why}` };
      if (action.kind === "delete") {
        const safe = insideDirs(action.path, dirs);
        if (!safe) return { ok: false, error: `${action.path} 不在授权目录里，拒绝删除` };
        await fs.rm(safe, { force: true });
        reverted += 1;
        continue;
      }
      const got = await editFileForModel(action.path, action.oldText, action.newText, dirs, false);
      if (!got.ok) return { ok: false, error: `回滚 ${action.path} 失败：${got.error}` };
      reverted += 1;
    }
    return { ok: true, reverted };
  });
}
