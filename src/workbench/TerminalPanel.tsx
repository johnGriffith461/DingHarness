import { useMemo, useState } from "react";

import { useWorkbenchStore } from "./store";

/**
 * 终端面板（F4）：**只读回放**本会话跑过的命令与输出。
 *
 * 为什么不给输入框：工具执行只有一条路径（模型 → `run_command` → 同一套权限）。
 * 在这里再开一个 shell 等于第二套执行路径，权限、留痕、落盘全要各写一遍 —— 那正是
 * 本项目反复清理的"两套实现慢慢不一致"。要看命令就跑一轮，回来在这里看。
 */

type CommandRow = {
  id: string;
  command: string;
  exitCode: number | null;
  ok: boolean;
  output: string;
  stepId: string;
};

function rowsOf(task: { steps: Array<{ id: string; tools?: Array<{ name: string; ok: boolean; input?: unknown; output?: unknown }> }> } | undefined): CommandRow[] {
  const rows: CommandRow[] = [];
  for (const step of task?.steps ?? []) {
    for (const [index, tool] of (step.tools ?? []).entries()) {
      if (tool.name !== "run_command") continue;
      const input = tool.input as { command?: string } | undefined;
      const output = tool.output as { exitCode?: number | null; text?: string; output?: string } | undefined;
      rows.push({
        id: `${step.id}-${index}`,
        command: input?.command ?? "（命令参数未记录）",
        exitCode: typeof output?.exitCode === "number" ? output.exitCode : null,
        ok: tool.ok,
        output: output?.text ?? output?.output ?? "",
        stepId: step.id,
      });
    }
  }
  return rows;
}

export function TerminalPanel() {
  const task = useWorkbenchStore((s) => s.tasks.find((t) => t.id === s.activeTaskId));
  const [query, setQuery] = useState("");
  const [onlyFailed, setOnlyFailed] = useState(false);
  const rows = useMemo(() => rowsOf(task), [task]);
  const q = query.trim().toLowerCase();
  const shown = rows.filter(
    (row) =>
      (!onlyFailed || !row.ok) &&
      (!q || row.command.toLowerCase().includes(q) || row.output.toLowerCase().includes(q)),
  );

  return (
    <div className="wb-setpage" data-testid="wb-terminal-page">
      <div className="wb-setpage-head">
        <b>终端</b>
      </div>
      <div className="wb-setpage-note">
        本会话跑过的命令与输出（只读回放，不提供输入框）。数据来自工具留痕，缺输出时如实写「输出未记录」。
      </div>
      <div className="wb-setpage-row">
        <input
          className="wb-model-search"
          data-testid="wb-terminal-search"
          placeholder="搜索命令或输出…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <button
          className={`wb-setpage-btn${onlyFailed ? " is-on" : ""}`}
          data-testid="wb-terminal-failed"
          onClick={() => setOnlyFailed((v) => !v)}
        >
          {onlyFailed ? "只看失败（开）" : "只看失败"}
        </button>
      </div>
      <div className="wb-setpage-body" data-testid="wb-terminal-list">
        {rows.length === 0 ? (
          <div className="wb-setpage-note" data-testid="wb-terminal-empty">
            本会话还没有命令
          </div>
        ) : shown.length === 0 ? (
          <div className="wb-setpage-note">没有匹配的命令</div>
        ) : (
          shown.map((row) => (
            <div className="wb-setpage-row wb-terminal-row" key={row.id} data-testid={`wb-terminal-${row.id}`}>
              <span className="wb-setpage-label">
                <code>{row.command}</code>
              </span>
              <em>
                退出码 {row.exitCode ?? "未知"} · {row.ok ? "成功" : "失败"}
              </em>
              <pre className="wb-terminal-output">{row.output.trim() || "输出未记录"}</pre>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
