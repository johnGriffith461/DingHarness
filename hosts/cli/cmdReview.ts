import fs from "node:fs/promises";
import path from "node:path";

import { createSqliteSessionStore } from "../../engine/adapters/sqliteStore";
import { fileChangesFrom, groupByPath, lineDiff, rollbackOf, summarizeChanges } from "../../engine/runtime/fileReview";
import { workdirsFromRecords } from "../../engine/runtime/reviewSessions";
import { editFileForModel } from "../../engine/runtime/tools/editTool";
import { insideDirs } from "../../engine/runtime/tools/drivePaths";
import { flag, flagAll, type Parsed } from "./args";
import { readConfig } from "./config";

/**
 * `ding review <会话 id>` —— **逐文件改动审阅与回滚**（U08，2026-10-18）。
 *
 * ## 为什么做成 CLI 而不是先做界面
 *
 * 逐文件审阅需要三样东西：会话日志里的 **改动意图**（`edit_file` 的 old/new、
 * `write_file` 的 content）、**当前磁盘状态**、以及一个**回滚入口**。
 * CLI 已经同时握着这三样（日志、目录白名单、文件工具），
 * 而界面那条路要新增 IPC 契约（`shared/ipc.ts` 的冻结面）——
 * 先把能力做出来、验对，再接界面，比反过来稳。
 *
 * ## 用法
 *
 * ```bash
 * ding review cli-xxxx                 # 看这段会话改了哪些文件、逐段 diff
 * ding review cli-xxxx --json          # 同一份数据的机器可读版
 * ding review cli-xxxx --revert a.ts   # 把某个文件回滚到改动前（只在可回滚时）
 * ```
 *
 * ⚠️ 回滚**只回滚日志里能证明的那些改动**：`edit_file` 用"把新文换回原文"；
 * `write_file` 只在"新建"时可删。覆盖写没有旧内容 —— 如实拒绝，不猜。
 */
export async function cmdReview(p: Parsed, dataDir: string): Promise<number> {
  const sessionId = p.args[0];
  if (!sessionId) {
    process.stderr.write("用法：ding review <会话 id> [--json] [--revert <文件路径>]\n");
    return 2;
  }

  const store = createSqliteSessionStore(dataDir);
  let records;
  try {
    const loaded = await store.load(sessionId);
    if (loaded.denied) {
      process.stderr.write("没有可给你的内容（这段会话不属于当前身份）。\n");
      return 1;
    }
    records = loaded.records;
  } finally {
    store.close();
  }
  if (!records.length) {
    process.stderr.write(`没有这段会话：${sessionId}\n`);
    return 1;
  }

  const changes = fileChangesFrom(records);
  const groups = groupByPath(changes);

  const revertPath = flag(p, "revert");
  if (revertPath) {
    const group = groups.find((g) => g.path === revertPath || path.basename(g.path) === revertPath);
    if (!group) {
      process.stderr.write(`这段会话没有改过「${revertPath}」。\n`);
      return 1;
    }
    /*
     * 目录白名单（T-08）：显式 `--dir` > **该会话当初的运行目录** > 配置里的 dirs > 当前目录。
     *
     * 缺陷形状（WorkBuddy 实测）：用户照着 `ding review` 打印的建议敲
     * `ding review <id> --revert <文件>`，但白名单里没有那个任务当初跑的目录，
     * 于是回滚**必然**报"不在可改范围内" —— 而用户完全不知道要补 `--dir`。
     * 会话日志里现在记了 `workdirs`（旧日志没有 → 回落配置/cwd，行为不变）。
     *
     * 回滚是**写操作** —— 它必须落在同一个白名单里，不能因为换了一条命令就放宽。
     */
    const explicit = flagAll(p, "dir");
    const configured = readConfig(dataDir).config.dirs ?? [];
    const fromSession = workdirsFromRecords(records);
    const dirs = resolveReviewDirs({ explicit, fromSession, configured, cwd: process.cwd() });
    /* 从**最后一条**开始回滚：同一文件改了多次时，逆序才能回到最初的样子 */
    let reverted = 0;
    for (const change of [...group.changes].reverse()) {
      const action = rollbackOf(change);
      if (action.kind === "impossible") {
        process.stderr.write(`× ${change.path}：${action.why}\n`);
        return 1;
      }
      if (action.kind === "delete") {
        const target = insideDirs(action.path, dirs);
        if (!target) {
          process.stderr.write(`× ${action.path} 不在授权目录里，拒绝删除。\n`);
          return 1;
        }
        await fs.rm(target, { force: true });
        reverted += 1;
        continue;
      }
      const got = await editFileForModel(action.path, action.oldText, action.newText, dirs, false);
      if (!got.ok) {
        process.stderr.write(`× 回滚 ${action.path} 失败：${got.error}\n`);
        return 1;
      }
      reverted += 1;
    }
    process.stdout.write(`✓ 已回滚 ${group.path} 的 ${reverted} 处改动\n`);
    return 0;
  }

  if (p.flags.has("json")) {
    process.stdout.write(`${JSON.stringify({ sessionId, summary: summarizeChanges(changes), files: groups }, null, 2)}\n`);
    return 0;
  }

  if (!changes.length) {
    process.stdout.write("这段会话没有写/改过文件。\n");
    return 0;
  }

  const summary = summarizeChanges(changes);
  process.stdout.write(
    `这段会话改了 ${summary.files} 个文件：${summary.edits} 处编辑 / ${summary.writes} 次写入（可回滚 ${summary.reversible} 处）\n`,
  );
  for (const group of groups) {
    process.stdout.write(`\n■ ${group.path}\n`);
    for (const change of group.changes) {
      process.stdout.write(`  · ${change.tool === "edit_file" ? "编辑" : "写入"}：${change.line}\n`);
      if (change.tool === "edit_file" && change.before !== undefined && change.after !== undefined) {
        for (const line of lineDiff(change.before, change.after, { maxLines: 60 })) {
          process.stdout.write(`    ${line.kind}${line.text}\n`);
        }
      } else if (change.after) {
        const lines = change.after.split("\n").slice(0, 40);
        for (const line of lines) process.stdout.write(`    +${line}\n`);
        if (change.after.split("\n").length > 40) process.stdout.write("    …\n");
      }
      if (!change.reversible) process.stdout.write(`    ⚠️ ${change.why}\n`);
    }
  }
  process.stdout.write(`\n回滚某个文件：ding review ${sessionId} --revert <路径>\n`);
  return 0;
}

/**
 * T-08：回滚时用哪一组目录（**纯函数**，便于单测）。
 *
 * 顺序：显式 `--dir` > 该会话当初的运行目录 > 配置里的 dirs > 当前目录。
 * 回滚是写操作，四个来源都只决定"白名单是什么"，**不改变**「必须在白名单内」这条。
 */
export function resolveReviewDirs(input: {
  explicit: readonly string[];
  fromSession: readonly string[];
  configured: readonly string[];
  cwd: string;
}): string[] {
  const chosen = input.explicit.length
    ? input.explicit
    : input.fromSession.length
      ? input.fromSession
      : input.configured.length
        ? input.configured
        : [input.cwd];
  return chosen.map((d) => path.resolve(d));
}
