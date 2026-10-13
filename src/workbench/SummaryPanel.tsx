/**
 * 从 `Workbench.tsx` 拆出来的（C6-1）。**纯挪位**：一个字没改，只加了 export 与 import。
 * 拆的理由见 `docs/PLAN-C6-结构拆分.md`：那个文件 2188 行、14 个顶层组件，
 * 改一处要读两千行 —— 于是「顺手加一行」变成默认做法。
 */

import { useState } from "react";
import { FolderOpen, MoreHorizontal, Plus, Settings } from "lucide-react";
import { useWorkbenchStore, openArtifact, revealArtifact } from "./store";
import { ARTIFACT_TITLE_GENERATING, SUMMARY_RECENT_FILES, SUMMARY_RECENT_LIMIT_NOTE, SUMMARY_SESSION_FILES, SUMMARY_TABS, type SummaryTabId } from "./copy";
import { resourceTypeOf } from "@shared/artifactProto";
import { ARTIFACT_FORMATS } from "./artifact";

import { formatBytes } from "./uiUtil";
import { MediaTab } from "./MediaTab";

export function SummaryPanel() {
  const task = useWorkbenchStore((s) => s.tasks.find((t) => t.id === s.activeTaskId) ?? null);
  const [tab, setTab] = useState<SummaryTabId>("artifacts");
  const [opening, setOpening] = useState<string | null>(null);
  const [note, setNote] = useState<string>("");

  const artifacts = task?.artifacts ?? [];

  return (
    <aside className="wb-summary" data-testid="wb-summary">
      <header className="wb-summary-head">
        <span>对话摘要</span>
        <button className="wb-icon" aria-label="摘要设置" title="摘要设置（本机版没有后端）" disabled>
          <Settings size={14} />
        </button>
        <button className="wb-icon" aria-label="收起" title="收起（本机版还没做面板折叠）" disabled>
          <MoreHorizontal size={14} />
        </button>
      </header>

      <div className="wb-tabs wb-summary-tabs" data-testid="wb-summary-tabs">
        {SUMMARY_TABS.map((t) => (
          <button
            key={t.id}
            className={`wb-tab${tab === t.id ? " is-on" : ""}`}
            data-testid={`wb-summary-tab-${t.id}`}
            title={t.key}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === "artifacts" ? (
        <div className="wb-summary-section">
          <div className="wb-summary-title">
            {SUMMARY_SESSION_FILES} <Plus size={13} />
          </div>
          {/* 上位说明：面板只扫会话里最近若干条消息的产物 */}
          <div className="wb-summary-desc" data-testid="wb-summary-desc">
            {SUMMARY_RECENT_LIMIT_NOTE}
          </div>
          {artifacts.length === 0 ? (
            <div className="wb-summary-empty" data-testid="wb-artifacts-empty">
              {task && task.stage === "done" ? "暂无产物" : "暂无"}
            </div>
          ) : (
            <div className="wb-artifacts" data-testid="wb-artifacts">
              {artifacts.map((artifact) => (
                <div className="wb-artifact" key={artifact.id} data-testid={`wb-artifact-${artifact.id}`}>
                  <button
                    className="wb-artifact-main"
                    title={artifact.filePath ?? "尚未落盘"}
                    /* 上位产物卡的稳定钩子之一，埋点与自动化都依赖它 */
                    data-office-artifact-card-kind={artifact.kind}
                    /*
                     * 协议类型编号。**两处渲染都要给** ——
                     * 同一份产物既出现在对话流里、也出现在右侧「对话产物」里，
                     * 只给一处的话，靠这个属性做的检查会随"看的是哪一处"而结论不同。
                     */
                    data-artifact-resource-type={resourceTypeOf(artifact.kind)}
                    onClick={() => {
                      if (!artifact.filePath) {
                        setNote("这个产物还没落盘");
                        return;
                      }
                      setOpening(artifact.id);
                      void openArtifact(artifact.filePath)
                        .then((error) => setNote(error ? `打不开：${error}` : ""))
                        .finally(() => setOpening(null));
                    }}
                  >
                    <span className={`wb-artifact-kind is-${artifact.kind}`}>
                      {ARTIFACT_FORMATS[artifact.kind].label}
                    </span>
                    <span className="wb-artifact-title">{artifact.title}</span>
                    <span className="wb-artifact-status" data-office-artifact-status={artifact.status}>
                      {artifact.status === "generating" ? ARTIFACT_TITLE_GENERATING : ""}
                    </span>
                    {opening === artifact.id ? <em className="wb-artifact-size">打开中…</em> : null}
                    {typeof artifact.bytes === "number" && opening !== artifact.id ? (
                      <em className="wb-artifact-size">{formatBytes(artifact.bytes)}</em>
                    ) : null}
                  </button>
                  <button
                    className="wb-icon"
                    aria-label="在文件夹里定位" title="在文件夹里定位"
                    data-testid={`wb-artifact-reveal-${artifact.id}`}
                    onClick={() => {
                      if (artifact.filePath) void revealArtifact(artifact.filePath);
                    }}
                  >
                    <FolderOpen size={12} />
                  </button>
                </div>
              ))}
            </div>
          )}
          {note ? (
            <div className="wb-summary-note" data-testid="wb-artifact-note">
              {note}
            </div>
          ) : null}
        </div>
      ) : tab === "media" ? (
        <MediaTab />
      ) : (
        <div className="wb-summary-section">
          <div className="wb-summary-title">{SUMMARY_TABS.find((t) => t.id === tab)?.label}</div>
          {/*
            这两个 tab 如实说明为什么是空的。

            ⚠️ 2026-10-13 更正一处**不实陈述**：子智能体那一句原来写着
            「本次实现不含子智能体调度」—— 而子智能体**早就落地了**（§150 端到端验过、
            §176 补了"上交父级就地批准"）。它只是**没有单独列在这里**：
            它跑完记在**发起它的那一步**上（那一行写着步数与用量，被拦下的动作也挂在那一步上）。
            这里说清"为什么空"与"去哪看"，不给一个和自己代码相反的说明。
          */}
          <div className="wb-summary-empty" data-testid={`wb-summary-empty-${tab}`}>
            {tab === "browser"
              ? "浏览器操作会话会出现在这里（需要「操作浏览器」能力接入）"
              : "子智能体不单独列在这里：它跑完记在发起它的那一步上（工具留痕里写着步数与用量）"}
          </div>
        </div>
      )}

      <div className="wb-summary-section">
        <div className="wb-summary-title">技能</div>
        <div className="wb-summary-empty">暂无</div>
      </div>

      <div className="wb-summary-section">
        <div className="wb-summary-title">{SUMMARY_RECENT_FILES}</div>
        <div className="wb-summary-empty">暂无</div>
      </div>
    </aside>
  );
}

/** 字节数说成人话。 */
