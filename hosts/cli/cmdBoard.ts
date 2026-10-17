import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

import {
  ackMessages,
  addTask,
  boardSummary,
  claimTask,
  createBoard,
  finishTask,
  inboxOf,
  postMessage,
  type Board,
} from "../../engine/core/taskBoard";
import type { Parsed } from "./args";

/**
 * `ding board` —— **团队任务板**（L02，2026-10-18）。
 *
 * ```
 * ding board                                   # 看板
 * ding board add "标题" [--after id1,id2]      # 加任务
 * ding board claim <id> --by 阿洁 --rev 1      # 认领（CAS：--rev 是你看的版本）
 * ding board done <id> [--by 阿洁] [--note …]  # 完成（--fail 标记失败）
 * ding board post <收件人> "内容" --by 阿洁     # 留言
 * ding board inbox [--by 阿洁] [--ack]         # 收件箱
 * ```
 *
 * 板落在 `<数据目录>/board.json`（原子写：先临时文件再改名）。
 * 判定全部在 `engine/core/taskBoard.ts`（有单测），这里只搬参数与打印。
 */

/** 板文件。 */
export function boardFile(dataDir: string): string {
  return path.join(dataDir, "board.json");
}

/** 读板（不存在/坏了都给空板；坏文件不覆盖）。 */
export function loadBoard(dataDir: string): { board: Board; note?: string } {
  try {
    const raw = JSON.parse(readFileSync(boardFile(dataDir), "utf8")) as Board;
    if (raw && Array.isArray(raw.tasks) && Array.isArray(raw.messages)) {
      return { board: { tasks: raw.tasks, messages: raw.messages, revision: Number(raw.revision) || 0 } };
    }
    return { board: createBoard(), note: "板文件形状不对（按空板处理，原文件没有覆盖）" };
  } catch {
    return { board: createBoard() };
  }
}

/** 原子写板。 */
export function saveBoard(dataDir: string, board: Board): void {
  const file = boardFile(dataDir);
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(board, null, 2)}\n`, "utf8");
  renameSync(tmp, file);
}

/** 参数里的值（`--x y`）。 */
function valueOf(p: Parsed, name: string): string | undefined {
  return p.flags.get(name)?.at(-1);
}

/**
 * `ding board …`。
 *
 * @param p 参数
 * @param dataDir 数据目录
 */
export function cmdBoard(p: Parsed, dataDir: string): number {
  const sub = p.args[0] ?? "list";
  const loaded = loadBoard(dataDir);
  if (loaded.note) process.stderr.write(`⚠️ ${loaded.note}\n`);
  let board = loaded.board;

  const commit = (result: { ok: true; board: Board } | { ok: false; error: string }): Board | null => {
    if (!result.ok) {
      process.stderr.write(`${result.error}\n`);
      return null;
    }
    saveBoard(dataDir, result.board);
    return result.board;
  };

  if (sub === "list" || sub === "show") {
    if (p.flags.has("json")) {
      process.stdout.write(`${JSON.stringify(board, null, 2)}\n`);
      return 0;
    }
    if (!board.tasks.length) {
      process.stdout.write("板上还没有任务。加一条：ding board add \"标题\"\n");
      return 0;
    }
    const s = boardSummary(board);
    process.stdout.write(
      `任务 ${board.tasks.length}（开放 ${s.open} / 已领 ${s.claimed} / 完成 ${s.done} / 失败 ${s.failed}）；可认领：${s.claimable.join(", ") || "-"}\n\n`,
    );
    for (const task of board.tasks) {
      const who = task.assignee ? ` @${task.assignee}` : "";
      const blocked = task.blockedBy.length ? ` ← ${task.blockedBy.join(",")}` : "";
      const note = task.note ? `　${task.note}` : "";
      process.stdout.write(`${task.id.padEnd(10)} [${task.status}] v${task.revision} ${task.title}${who}${blocked}${note}\n`);
    }
    return 0;
  }

  if (sub === "add") {
    const title = p.args.slice(1).join(" ").trim();
    const after = (valueOf(p, "after") ?? "")
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean);
    const id = valueOf(p, "id");
    const got = addTask(board, { title, ...(id ? { id } : {}), ...(after.length ? { blockedBy: after } : {}) });
    const next = commit(got);
    if (!next) return 1;
    const last = next.tasks.at(-1)!;
    process.stdout.write(`✓ 加了 ${last.id}（v${last.revision}）：${last.title}\n`);
    return 0;
  }

  if (sub === "claim") {
    const taskId = p.args[1];
    const by = valueOf(p, "by");
    const rev = Number(valueOf(p, "rev") ?? "1");
    if (!taskId || !by) {
      process.stderr.write("用法：ding board claim <任务 id> --by <人> [--rev <版本>]\n");
      return 2;
    }
    const next = commit(claimTask(board, { taskId, assignee: by, revision: Number.isFinite(rev) ? rev : 1 }));
    if (!next) return 1;
    board = next;
    process.stdout.write(`✓ ${by} 领了 ${taskId}（现在 v${board.tasks.find((t) => t.id === taskId)?.revision}）\n`);
    return 0;
  }

  if (sub === "done" || sub === "fail") {
    const taskId = p.args[1];
    if (!taskId) {
      process.stderr.write("用法：ding board done|fail <任务 id> [--by <人>] [--note <说明>]\n");
      return 2;
    }
    const result = finishTask(board, {
      taskId,
      status: sub === "done" ? "done" : "failed",
      ...(valueOf(p, "by") ? { by: valueOf(p, "by")! } : {}),
      ...(valueOf(p, "note") ? { note: valueOf(p, "note")! } : {}),
    });
    if (!commit(result)) return 1;
    process.stdout.write(`✓ ${taskId} → ${sub === "done" ? "完成" : "失败"}\n`);
    return 0;
  }

  if (sub === "post") {
    const to = p.args[1];
    const text = p.args.slice(2).join(" ").trim();
    const from = valueOf(p, "by");
    if (!to || !text || !from) {
      process.stderr.write('用法：ding board post <收件人> "内容" --by <发件人>\n');
      return 2;
    }
    if (!commit(postMessage(board, { from, to, text }))) return 1;
    process.stdout.write(`✓ 已发给 ${to}\n`);
    return 0;
  }

  if (sub === "inbox") {
    const by = valueOf(p, "by");
    if (!by) {
      process.stderr.write("用法：ding board inbox --by <人> [--ack]\n");
      return 2;
    }
    const messages = inboxOf(board, by);
    if (!messages.length) {
      process.stdout.write(`${by} 的收件箱是空的。\n`);
      return 0;
    }
    for (const message of messages) {
      process.stdout.write(`${message.id}　${message.from}：${message.text}（${new Date(message.at).toLocaleString("zh-CN")}）\n`);
    }
    if (p.flags.has("ack")) {
      if (!commit(ackMessages(board, by))) return 1;
      process.stdout.write(`✓ 已标记 ${messages.length} 条为已读\n`);
    }
    return 0;
  }

  process.stderr.write("用法：ding board [list|add|claim|done|fail|post|inbox] …\n");
  return 2;
}
