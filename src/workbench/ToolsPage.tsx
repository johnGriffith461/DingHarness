import { useEffect, useState } from "react";

import type { ShellBridge, ToolInfoWire } from "@shared/ipc";

/**
 * 工具面板（D2）。
 *
 * 数据源是**主进程当前注册表**（`tools:list`）：内置 + MCP + 插件都在里面。
 * 这一页要回答的问题是"模型到底够得着什么、哪些只读、哪些会串行、结果怎么落"——
 * 不是再列一份手写清单（那会与注册表漂）。
 */

const bridge = (): ShellBridge | undefined => (globalThis as unknown as { shell?: ShellBridge }).shell;

const SOURCE_LABEL: Record<ToolInfoWire["source"], string> = {
  builtin: "内置",
  mcp: "连接器",
  plugin: "插件",
};

export function ToolsPage() {
  const [tools, setTools] = useState<ToolInfoWire[]>([]);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  /* F1：连接器资源与提示词（服务端没声明就是空数组） */
  const [resources, setResources] = useState<Array<{ server: string; uri: string; name: string; mimeType?: string }>>([]);
  const [prompts, setPrompts] = useState<Array<{ server: string; name: string; description?: string }>>([]);
  const [preview, setPreview] = useState("");

  useEffect(() => {
    void (async () => {
      try {
        const list = await bridge()?.tools?.list?.();
        setTools(Array.isArray(list) ? list : []);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
      const mcp = bridge()?.mcp;
      const res = await Promise.resolve(mcp?.resources?.()).catch(() => []);
      setResources(Array.isArray(res) ? res : []);
      const listedPrompts = await Promise.resolve(mcp?.prompts?.()).catch(() => []);
      setPrompts(Array.isArray(listedPrompts) ? listedPrompts : []);
    })();
  }, []);

  const q = query.trim().toLowerCase();
  const shown = tools.filter((t) => !q || t.name.toLowerCase().includes(q) || t.description.toLowerCase().includes(q));

  return (
    <div className="wb-setpage" data-testid="wb-tools-page">
      <div className="wb-setpage-head">
        <b>工具</b>
      </div>
      <div className="wb-setpage-note">
        模型当前够得着的工具与元数据（来自注册表，不是另一份清单）。只读工具可并行；
        写与命令类串行执行，避免一次回复里两个写动作同时落盘。
      </div>
      <div className="wb-setpage-note">连接器资源（F1）：{resources.length ? `${resources.length} 个` : "没有 server 声明 resources"}</div>
      {resources.slice(0, 30).map((item) => (
        <div className="wb-setpage-row" key={`${item.server}:${item.uri}`} data-testid={`wb-mcp-resource-${item.name}`}>
          <span className="wb-setpage-label">
            {item.server} / {item.name}
          </span>
          <button
            className="wb-setpage-btn"
            onClick={() =>
              void Promise.resolve(bridge()?.mcp?.readResource?.(item.server, item.uri))
                .then((contents) => setPreview((contents ?? []).map((c) => c.text).join("\n\n") || "（资源没有文本内容）"))
                .catch((err) => setPreview(`读取失败：${err instanceof Error ? err.message : String(err)}`))
            }
          >
            读取
          </button>
        </div>
      ))}
      {preview ? (
        <pre className="wb-terminal-output" data-testid="wb-mcp-preview">
          {preview}
        </pre>
      ) : null}
      <div className="wb-setpage-note">连接器提示词（F1）：{prompts.length ? `${prompts.length} 个` : "没有 server 声明 prompts"}</div>
      {prompts.slice(0, 30).map((item) => (
        <div className="wb-setpage-row" key={`${item.server}:${item.name}`}>
          <span className="wb-setpage-label">
            {item.server} / {item.name}
          </span>
          <em>{item.description ?? ""}</em>
        </div>
      ))}
      <input
        className="wb-model-search"
        data-testid="wb-tools-search"
        placeholder="搜索工具名或说明…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      {error ? <div className="wb-setpage-note">读取失败：{error}</div> : null}
      <div className="wb-setpage-body" data-testid="wb-tools-list">
        {shown.length === 0 ? (
          <div className="wb-setpage-note">{tools.length ? "没有匹配的工具" : "读取中…"}</div>
        ) : (
          shown.map((tool) => (
            <div className="wb-setpage-row" key={tool.name} data-testid={`wb-tool-${tool.name}`}>
              <span className="wb-setpage-label">
                {tool.name}
                <em className="wb-chip-badge">{SOURCE_LABEL[tool.source]}</em>
              </span>
              <em>
                {tool.readOnly ? "只读" : tool.destructive ? "破坏性" : "可写"} ·{" "}
                {tool.concurrency === "safe" ? "可并行" : "串行"} · 结果
                {tool.resultPolicy === "tail" ? "留尾部" : tool.resultPolicy === "spill" ? "落盘" : "内联"}
                {tool.timeoutMs ? ` · 超时 ${Math.round(tool.timeoutMs / 1000)}s` : ""}
              </em>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
