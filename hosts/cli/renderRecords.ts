import { splitTurns, type LogRecord } from "../../engine/core/events";
import { ledgerOf } from "../../engine/core/ledger";

/**
 * 把一段记录渲染成人看的终端输出（Phase 18 从 `ding.ts` 那一份口径拆出来）。
 *
 * ⚠️ **为什么单独一个文件**：`ding recipe run` 也要渲染结果，
 * 而"再写一份怎么显示"必然漂（本项目因为这种重复吃过几次亏）。
 *
 * 与 `ding run` 的既有行为一致：正文按轮次顺序打出，工具留痕带缩进，每轮末尾一行用量。
 *
 * ⚠️ 用量那一行只打**输入/输出**（provider 没给就不打），
 * 不做"合计/单价"那些换算 —— 那是成本账本（`ding sessions --cost`）的活，
 * 两份换算放一起迟早对不上。
 */
export function renderRecords(records: readonly LogRecord[]): string {
  const out: string[] = [];
  /* 逐轮的记录按 requestId 从外面这份里筛（`TurnChunk` 上没有 records） */
  const byRequest = new Map<string, LogRecord[]>();
  for (const r of records) {
    const rid = r.requestId;
    if (!rid) continue;
    const list = byRequest.get(rid) ?? [];
    list.push(r);
    byRequest.set(rid, list);
  }

  for (const chunk of splitTurns(records)) {
    const user = chunk.request?.messages
      .filter((m) => m.role === "user")
      .map((m) => m.content)
      .join("\n");
    if (user) out.push(`\n❯ ${user}`);

    for (const trace of chunk.view.traces) {
      const mark = trace.pending ? "⏸" : trace.ok === false ? "✗" : "✓";
      out.push(`  ${mark} ${trace.name}${trace.line ? ` — ${trace.line}` : ""}`);
    }
    if (chunk.view.text.trim()) out.push(`\n${chunk.view.text.trim()}`);

    const id = chunk.request?.requestId;
    for (const entry of id ? ledgerOf(byRequest.get(id) ?? [], id) : []) {
      const u = entry.usage;
      if (!u) continue;
      out.push(`  \x1b[2m（用量 ↑${u.inputTokens ?? "-"} ↓${u.outputTokens ?? "-"}）\x1b[0m`);
    }
  }
  return out.join("\n") + "\n";
}
