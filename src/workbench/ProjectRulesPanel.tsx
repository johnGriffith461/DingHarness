import { useCallback, useEffect, useState } from "react";

import type { ShellBridge } from "@shared/ipc";
import type { ProjectContextResult } from "@shared/projectWire";

/**
 * 设置 → 通用 →「项目规则」（A1/A2）。
 *
 * 它显示的是**真的被读进系统提示词的那几个文件**：路径、字节数、修改时间。
 * 不是"我们知道有 AGENTS.md 这个约定"——是"这一轮模型确实看到了它"。
 *
 * 读取在主进程（`project.reload` 会清缓存后重读）；这里只负责显示与触发。
 */

const bridge = (): ShellBridge | undefined => (globalThis as unknown as { shell?: ShellBridge }).shell;

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}

function formatTime(ms: number): string {
  try {
    return new Date(ms).toLocaleString();
  } catch {
    return "时间未知";
  }
}

export function ProjectRulesPanel() {
  const [data, setData] = useState<ProjectContextResult | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async (reload: boolean) => {
    const project = bridge()?.project;
    if (!project) {
      setError("桌面通道不可用（浏览器里跑时读不到项目文件）");
      return;
    }
    setBusy(true);
    setError("");
    try {
      setData(await (reload ? project.reload() : project.context()));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    void load(false);
  }, [load]);

  const ctx = data?.context;

  return (
    <div className="wb-setpage-body" data-testid="wb-project-rules">
      <div className="wb-setpage-row">
        <span className="wb-setpage-label">项目规则</span>
        <button className="wb-setpage-btn" data-testid="wb-project-reload" onClick={() => void load(true)}>
          {busy ? "读取中…" : "重新加载"}
        </button>
      </div>

      {error ? (
        <div className="wb-setpage-row" data-testid="wb-project-error">
          <span className="wb-setpage-label">读取失败</span>
          <em style={{ color: "var(--danger)" }}>{error}</em>
        </div>
      ) : null}

      {ctx ? (
        <>
          <div className="wb-setpage-row">
            <span className="wb-setpage-label">工作目录</span>
            <em data-testid="wb-project-cwd">{ctx.cwd}</em>
          </div>
          {ctx.gitRoot ? (
            <div className="wb-setpage-row">
              <span className="wb-setpage-label">Git 根目录</span>
              <em>{ctx.gitRoot}</em>
            </div>
          ) : null}
          <div className="wb-setpage-row">
            <span className="wb-setpage-label">环境</span>
            <em>
              {[ctx.platform, ctx.packageManager, ctx.testCommand].filter(Boolean).join(" · ") || "未探测到包管理器与测试命令"}
            </em>
          </div>

          {ctx.rules.length === 0 ? (
            <div className="wb-setpage-row" data-testid="wb-project-empty">
              <span className="wb-setpage-label">已加载文件</span>
              <em>没有找到 AGENTS.md / CLAUDE.md（模型第一轮不会收到项目规则）</em>
            </div>
          ) : (
            ctx.rules.map((rule) => (
              <div className="wb-setpage-row" key={rule.path} data-testid="wb-project-rule">
                <span className="wb-setpage-label">{rule.source === "global" ? "全局规则" : "项目规则"}</span>
                <em>
                  {rule.path} — {formatBytes(rule.bytes)} — {formatTime(rule.mtimeMs)}
                </em>
              </div>
            ))
          )}

          {ctx.truncated ? (
            <div className="wb-setpage-row">
              <span className="wb-setpage-label">截断</span>
              <em>规则总量超过上限，已截断（单文件 32 KiB / 总量 48 KiB）</em>
            </div>
          ) : null}

          {(ctx.errors ?? []).map((item) => (
            <div className="wb-setpage-row" key={item.path} style={{ color: "var(--danger)" }}>
              <span className="wb-setpage-label">读取失败</span>
              <em>
                {item.path} — {item.error}
              </em>
            </div>
          ))}
        </>
      ) : !error ? (
        <div className="wb-setpage-row">
          <span className="wb-setpage-label">已加载文件</span>
          <em>读取中…</em>
        </div>
      ) : null}
    </div>
  );
}
