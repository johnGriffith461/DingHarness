import { useEffect, useMemo, useState } from "react";
import { Copy, RefreshCw } from "lucide-react";

import type { ShellBridge, WorkflowRunView, WorkflowSpecView } from "@shared/ipc";
import { NavCollapseButton } from "./NavCollapseButton";
import { layersOf, progressOf, resumeCommand, timelineOf, formatDuration } from "./workflowView";

/**
 * 工作流与 Agent Teams 可视化（V6-2l）。
 *
 * 这一页是**只读的**：运行在 CLI（`ding workflow run`），桌面展示泳道与状态，
 * 并给出续跑命令。为什么不在这里也放一个"开始"按钮：那需要在主进程再装配一套
 * 引擎/凭据，与 CLI 那条必然漂；而"两条路各跑一套"正是这个仓一直在清的那类缺陷。
 */

const STATUS_COLOR: Record<string, string> = {
  pending: "var(--muted, #888)",
  running: "#b08800",
  done: "#2ea043",
  failed: "#da3633",
  skipped: "var(--muted, #888)",
};

const RUN_LABEL: Record<WorkflowRunView["status"], string> = {
  running: "进行中",
  paused: "已暂停",
  done: "完成",
  failed: "失败",
};

function shell(): ShellBridge | null {
  return (globalThis as { shell?: ShellBridge }).shell ?? null;
}

function fmtTime(at: number): string {
  if (!at) return "—";
  return new Date(at).toISOString().slice(0, 16).replace("T", " ");
}

export function WorkflowPage() {
  const [tab, setTab] = useState<"runs" | "specs">("runs");
  const [specs, setSpecs] = useState<WorkflowSpecView[]>([]);
  const [runs, setRuns] = useState<WorkflowRunView[]>([]);
  const [dir, setDir] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [note, setNote] = useState("正在读取工作流…");
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState("weekly-report");
  const [json, setJson] = useState(
    '{\n  "name": "周报流水线",\n  "steps": [\n    { "id": "research", "agent": "researcher", "task": "收集本周数据" },\n    { "id": "write", "agent": "writer", "task": "写成周报", "dependsOn": ["research"] }\n  ]\n}\n',
  );
  const [saved, setSaved] = useState<{ file: string; runCommand: string } | null>(null);

  const refresh = async () => {
    const api = shell();
    if (!api?.workflows) {
      setNote("这一页要在桌面端打开（浏览器预览里没有本机工作流目录）。");
      return;
    }
    setBusy(true);
    try {
      const data = await api.workflows.list();
      setSpecs(data.specs);
      setRuns(data.runs);
      setDir(data.dir);
      if (!selected && data.runs.length) setSelected(data.runs[0]!.id);
      setNote(
        data.runs.length || data.specs.length
          ? `定义 ${data.specs.length} 份　运行 ${data.runs.length} 次（${data.dir}）`
          : "还没有工作流。先在「定义」里保存一份，再用下方命令运行。",
      );
    } catch (error) {
      setNote(`读取失败：${String((error as Error)?.message ?? error)}`);
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const run = useMemo(() => runs.find((r) => r.id === selected) ?? runs[0] ?? null, [runs, selected]);
  const layers = useMemo(() => (run ? layersOf(run.steps) : []), [run]);
  const progress = useMemo(() => (run ? progressOf(run.steps) : { done: 0, total: 0 }), [run]);

  /*
   * 时间线（G10）：正在跑的步骤右端是"现在"，所以要有个每秒走一次的钟。
   * 只在**有运行中的步骤**时才起定时器（静止的页不该每秒重渲染）。
   */
  const [now, setNow] = useState(() => Date.now());
  const hasRunning = run?.steps.some((s) => s.status === "running") ?? false;
  useEffect(() => {
    if (!hasRunning) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [hasRunning]);
  const timeline = useMemo(() => (run ? timelineOf(run, now) : null), [run, now]);

  const copy = (text: string) => {
    void navigator.clipboard?.writeText(text).then(
      () => setNote(`已复制：${text}`),
      () => setNote(`复制失败，请手动复制：${text}`),
    );
  };

  const save = async () => {
    const api = shell();
    if (!api?.workflows) return;
    const got = await api.workflows.saveSpec(name, json);
    if (!got.ok) {
      setNote(`保存失败：${got.error}`);
      setSaved(null);
      return;
    }
    setSaved({ file: got.file, runCommand: got.runCommand });
    setNote(`已保存：${got.file}`);
    void refresh();
  };

  return (
    <div className="wb-setpage-body" data-testid="wb-workflow">
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <NavCollapseButton />
        <button
          type="button"
          className="wb-chip"
          data-testid="wb-workflow-runs-tab"
          aria-pressed={tab === "runs"}
          onClick={() => setTab("runs")}
        >
          运行
        </button>
        <button
          type="button"
          className="wb-chip"
          data-testid="wb-workflow-specs-tab"
          aria-pressed={tab === "specs"}
          onClick={() => setTab("specs")}
        >
          定义
        </button>
        <button type="button" className="wb-chip" data-testid="wb-workflow-refresh" disabled={busy} onClick={() => void refresh()}>
          <RefreshCw size={14} /> {busy ? "读取中…" : "刷新"}
        </button>
      </div>
      <p className="wb-setpage-note" data-testid="wb-workflow-note">
        {note}
      </p>

      {tab === "runs" ? (
        runs.length ? (
          <div style={{ display: "grid", gridTemplateColumns: "220px minmax(0,1fr)", gap: 12 }}>
            <ul className="wb-card" style={{ listStyle: "none", margin: 0, padding: 8 }} data-testid="wb-workflow-runlist">
              {runs.map((item) => (
                <li key={item.id}>
                  <button
                    type="button"
                    className="wb-chip"
                    aria-pressed={run?.id === item.id}
                    data-testid={`wb-workflow-run-${item.id}`}
                    style={{ display: "block", width: "100%", textAlign: "left" }}
                    onClick={() => setSelected(item.id)}
                  >
                    <strong>{item.name}</strong>
                    <br />
                    <span style={{ color: STATUS_COLOR[item.status === "done" ? "done" : item.status === "failed" ? "failed" : "running"] }}>
                      {RUN_LABEL[item.status]}
                    </span>
                    <span className="wb-card-desc">　{fmtTime(item.updatedAt)}</span>
                  </button>
                </li>
              ))}
            </ul>

            <div data-testid="wb-workflow-lanes">
              {run ? (
                <>
                  <div className="wb-card" style={{ padding: 10, marginBottom: 8 }} data-testid="wb-workflow-runhead">
                    <strong>{run.name}</strong>　{RUN_LABEL[run.status]}　
                    {progress.done}/{progress.total} 步
                    {run.error ? <span style={{ color: STATUS_COLOR.failed }}>　{run.error}</span> : null}
                    {run.status === "paused" || run.status === "failed" ? (
                      <div style={{ marginTop: 6, display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
                        <code>{resumeCommand(run.id, dir)}</code>
                        <button
                          type="button"
                          className="wb-chip"
                          data-testid="wb-workflow-copy-resume"
                          onClick={() => copy(resumeCommand(run.id, dir))}
                        >
                          <Copy size={12} /> 复制续跑命令
                        </button>
                      </div>
                    ) : null}
                  </div>

                  {/* G10 时间线：泳道回答"谁依赖谁"，这一条回答"时间花在哪、有没有真并行" */}
                  {timeline ? (
                    <div data-testid="wb-workflow-timeline" style={{ marginBottom: 10 }}>
                      <div className="wb-card-desc" style={{ marginBottom: 4 }}>
                        时间线（总 {formatDuration(timeline.spanMs)}）
                      </div>
                      <div
                        style={{
                          position: "relative",
                          height: 34,
                          background: "var(--bg-2)",
                          border: "1px solid var(--line)",
                          borderRadius: 6,
                        }}
                      >
                        {timeline.segments.map((seg) => (
                          <div
                            key={seg.id}
                            data-testid={`wb-workflow-timeline-${seg.id}`}
                            title={`${seg.id} · ${seg.agent} · ${formatDuration(seg.durationMs)}`}
                            style={{
                              position: "absolute",
                              left: `${seg.leftPct}%`,
                              width: `${seg.widthPct}%`,
                              top: 4,
                              height: 24,
                              background: STATUS_COLOR[seg.status],
                              opacity: seg.live ? 0.7 : 0.92,
                              borderRadius: 4,
                              color: "#fff",
                              fontSize: 11,
                              lineHeight: "24px",
                              padding: "0 5px",
                              overflow: "hidden",
                              whiteSpace: "nowrap",
                            }}
                          >
                            {seg.id}
                          </div>
                        ))}
                      </div>
                    </div>
                  ) : null}

                  <div style={{ display: "flex", gap: 10, overflowX: "auto", paddingBottom: 6 }}>
                    {layers.map((layer) => (
                      <div key={layer.index} style={{ minWidth: 190, flex: "0 0 auto" }} data-testid={`wb-workflow-layer-${layer.index}`}>
                        <div className="wb-card-desc" style={{ marginBottom: 4 }}>
                          第 {layer.index + 1} 层{layer.steps.length > 1 ? "（并行）" : ""}
                        </div>
                        {layer.steps.map((step) => (
                          <div
                            key={step.id}
                            className="wb-card"
                            data-testid={`wb-workflow-step-${step.id}`}
                            title={step.summary || step.error || step.task}
                            style={{ padding: 8, marginBottom: 6, borderLeft: `3px solid ${STATUS_COLOR[step.status]}` }}
                          >
                            <div>
                              <strong>{step.id}</strong>{" "}
                              <span className="wb-card-desc">[{step.agent}]</span>
                            </div>
                            <div style={{ color: STATUS_COLOR[step.status], fontSize: 12 }}>
                              {step.status === "pending"
                                ? "等待"
                                : step.status === "running"
                                  ? "进行中"
                                  : step.status === "done"
                                    ? "完成"
                                    : step.status === "failed"
                                      ? "失败"
                                      : "跳过"}
                            </div>
                            {step.dependsOn.length ? (
                              <div className="wb-card-desc">依赖 {step.dependsOn.join(" / ")}</div>
                            ) : null}
                            {step.error ? <div style={{ color: STATUS_COLOR.failed, fontSize: 12 }}>{step.error}</div> : null}
                          </div>
                        ))}
                      </div>
                    ))}
                  </div>
                </>
              ) : null}
            </div>
          </div>
        ) : (
          <p className="wb-setpage-note">
            还没有运行记录。到「定义」里保存一份，然后跑 <code>ding workflow run &lt;文件&gt;</code>。
          </p>
        )
      ) : (
        <>
          <h4>已有的定义</h4>
          {specs.length ? (
            <ul className="wb-card" style={{ listStyle: "none", margin: 0, padding: 8 }} data-testid="wb-workflow-speclist">
              {specs.map((spec) => (
                <li key={spec.file} className="wb-card-row">
                  <span className="wb-card-label">
                    {spec.name}（{spec.steps} 步）
                  </span>
                  <span className="wb-card-desc">
                    {spec.valid ? "合法" : `有错误：${spec.errors?.join("；")}`}　{spec.file}
                  </span>
                  {spec.valid ? (
                    <button type="button" className="wb-chip" onClick={() => copy(`ding workflow run "${spec.file}"`)}>
                      <Copy size={12} /> 复制运行命令
                    </button>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : (
            <p className="wb-setpage-note">还没有保存过定义。</p>
          )}

          <h4>新建 / 编辑定义</h4>
          <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 6 }}>
            <input className="wb-input" data-testid="wb-workflow-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="文件名（字母/数字/-_）" />
            <button type="button" className="wb-chip" data-testid="wb-workflow-save" onClick={() => void save()}>
              保存定义
            </button>
          </div>
          <textarea
            className="wb-input"
            data-testid="wb-workflow-json"
            value={json}
            onChange={(e) => setJson(e.target.value)}
            rows={14}
            spellCheck={false}
            style={{ width: "100%", fontFamily: "ui-monospace, Consolas, monospace", fontSize: 12.5 }}
          />
          {saved ? (
            <p className="wb-setpage-note" data-testid="wb-workflow-saved">
              已保存：<code>{saved.file}</code>
              <br />
              运行：<code>{saved.runCommand}</code>
              <button type="button" className="wb-chip" onClick={() => copy(saved.runCommand)}>
                <Copy size={12} /> 复制
              </button>
            </p>
          ) : null}
        </>
      )}
    </div>
  );
}
