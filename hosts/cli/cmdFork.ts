/**
 * `ding fork` —— 从会话的**任一时点**分叉（V6-4a）。
 *
 * 与 `ding sessions --export` / 桌面整段 fork 的区别：
 *   · 整段 fork 复制"现在"的全部记录；
 *   · 这里可以只复制到第 N 轮（或第 N 号事件）—— "回到那一刻重新走另一条路"。
 *
 * 复制的是**记录前缀**（不是快照/投影）：新会话照样能被 `resume` / `replay`，
 * 投影与原会话那一刻逐轮一致（`forkReplaysEqual` 的判据）。
 *
 * ⚠️ 副作用：副本里的工具调用是**历史**，回看不执行；**接着跑**才会真的再执行一次。
 * 那句警示随复制结果一起打出来（`forkNote`）。
 */
import { forkSessionAt, forkPoints } from "../../engine/core/fork";
import { buildEngine } from "./assembly";
import { flag, flagAll, parseIntFlagValue, type Parsed } from "./args";

/** 默认新会话 id：源 id + 短时间戳（可读、可再分叉）。 */
function defaultInto(source: string): string {
  return `${source}-fork-${Date.now().toString(36)}`;
}

export async function cmdFork(p: Parsed, dataDir: string): Promise<number> {
  const source = p.args[0];
  if (!source) {
    process.stderr.write(
      "用法：ding fork <源会话 id> [--at-turn N | --at-seq N] [--into <新 id>] [--list]\n" +
        "  --list 只列出可分叉的轮次（不复制）。\n",
    );
    return 2;
  }
  if (flagAll(p, "at-turn").length && flagAll(p, "at-seq").length) {
    process.stderr.write("--at-turn 与 --at-seq 只能给一个（两种时点口径）。\n");
    return 2;
  }

  const built = await buildEngine([process.cwd()], dataDir);
  try {
    const { records } = await built.store.load(source);
    if (!records.length) {
      process.stderr.write(`会话不存在或没有记录：${source}\n`);
      return 2;
    }

    /* `--list`：只列分叉点（人在选之前要看得到"第几轮在说什么"） */
    if (p.flags.has("list")) {
      const points = forkPoints(records);
      process.stdout.write(`${source} 共 ${points.length} 轮，可分叉点：\n`);
      for (const point of points) {
        const when = point.at ? new Date(point.at).toISOString().replace("T", " ").slice(0, 19) : "(无时刻)";
        process.stdout.write(`  --at-turn ${point.turn}  ${when}  ${point.label}\n`);
      }
      return 0;
    }

    const points = forkPoints(records);
    const atTurnRaw = flag(p, "at-turn");
    const atSeqRaw = flag(p, "at-seq");
    let at: { kind: "turn"; turn: number } | { kind: "seq"; seq: number };
    if (atTurnRaw !== undefined) {
      const parsed = parseIntFlagValue(atTurnRaw, "at-turn", { min: 1, max: Math.max(1, points.length), fallback: points.length });
      if (!parsed.ok) {
        process.stderr.write(`${parsed.message}\n`);
        return 2;
      }
      at = { kind: "turn", turn: parsed.value };
    } else if (atSeqRaw !== undefined) {
      const parsed = parseIntFlagValue(atSeqRaw, "at-seq", { min: 0, max: Number.MAX_SAFE_INTEGER, fallback: 0 });
      if (!parsed.ok) {
        process.stderr.write(`${parsed.message}\n`);
        return 2;
      }
      at = { kind: "seq", seq: parsed.value };
    } else {
      /* 不给时点 = 整段复制（与既有桌面 fork 同义） */
      at = { kind: "turn", turn: Math.max(1, points.length) };
    }

    const into = flag(p, "into") ?? defaultInto(source);
    if (into === source) {
      process.stderr.write("目标会话不能是源会话自己（那不是分叉，是往原会话追加）。\n");
      return 2;
    }
    const existing = await built.store.load(into);
    if (existing.records.length) {
      process.stderr.write(`目标会话 ${into} 已经有内容了（换一个 --into，或先删掉它）。\n`);
      return 2;
    }

    const plan = forkSessionAt(records, { source: { sessionId: source }, into: { sessionId: into }, at });
    if (!plan.records.length) {
      process.stderr.write(`分叉点落在第一条记录之前，没有可复制的记录。\n`);
      return 2;
    }
    await built.store.append(into, plan.records, { forkedFrom: source });

    process.stdout.write(
      `已分叉：${source} → ${into}\n` +
        `  复制 ${plan.cutoff} 条记录（到第 ${at.kind === "turn" ? `${at.turn} 轮` : `${at.seq} 号事件`} 为止）\n` +
        `  ${plan.note}\n`,
    );
    return 0;
  } finally {
    built.close();
  }
}
