import { useCallback, useEffect, useState } from "react";

import type { ShellBridge } from "@shared/ipc";

/**
 * G6：LSP 服务器（设置 → 通用页里的一块）。
 *
 * 只做"看见配置与状态 + 重连"：配置本身在 `lsp.json`（与 MCP 的 `mcp.json` 同一形态）。
 * 没配置时这一段明确说"编辑不附诊断"，而不是画一个看起来能用的开关。
 */

type LspView = Awaited<ReturnType<NonNullable<ShellBridge["lsp"]>["list"]>>;

function shellBridge(): ShellBridge | undefined {
  return (globalThis as unknown as { shell?: ShellBridge }).shell;
}

const STATUS_LABEL: Record<string, string> = {
  stopped: "未启动（第一次编辑时启动）",
  starting: "启动中…",
  on: "已连接",
  error: "启动失败",
};

export function LspPanel() {
  const [view, setView] = useState<LspView | null>(null);
  const [note, setNote] = useState("");

  const pull = useCallback(() => {
    void shellBridge()
      ?.lsp?.list?.()
      .then((got) => setView(got ?? null))
      .catch(() => setView(null));
  }, []);

  useEffect(() => {
    pull();
  }, [pull]);

  const servers = view?.servers ?? [];
  return (
    <div className="wb-lsp" data-testid="wb-lsp-servers">
      <div className="wb-setpage-row">
        <span className="wb-setpage-label">LSP 诊断</span>
        <em>
          {view
            ? view.enabled
              ? servers.length
                ? `已配置 ${servers.length} 个语言服务器`
                : "未配置（编辑不附诊断）"
              : "已关闭（lsp.json 的 enabled:false）"
            : "读取中…"}
        </em>
      </div>
      {servers.map((server) => (
        <div className="wb-lsp-item" key={`${server.languageId}-${server.command}`} data-testid={`wb-lsp-${server.languageId}`}>
          <b>{server.languageId}</b>
          <em>{[server.command, ...server.args].join(" ")}</em>
          <span className="wb-lsp-status" data-testid={`wb-lsp-status-${server.languageId}`}>
            {STATUS_LABEL[server.status] ?? server.status}
          </span>
          {server.error ? <span className="wb-mcp-error">{server.error}</span> : null}
        </div>
      ))}
      <div className="wb-mcp-actions">
        <button
          className="wb-page-btn"
          data-testid="wb-lsp-reload"
          onClick={() => {
            void shellBridge()
              ?.lsp?.reload?.()
              .then((got) => {
                setView(got ?? null);
                setNote("已重新加载配置");
              })
              .catch(() => setNote("重新加载失败"));
          }}
        >
          重新加载配置
        </button>
        {note ? (
          <span className="wb-cloud-note" data-testid="wb-lsp-note">
            {note}
          </span>
        ) : null}
      </div>
      {view?.file ? (
        <div className="wb-mcp-file" data-testid="wb-lsp-file">
          配置文件：{view.file}
        </div>
      ) : null}
      <div className="wb-mcp-file">
        编辑成功后只报**新引入**的 error（warning 不报）；没配置时完全跳过，不影响编辑。
      </div>
    </div>
  );
}
