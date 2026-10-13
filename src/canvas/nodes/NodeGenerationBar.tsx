import { useMemo, useState } from "react";
import { AlertTriangle, ChevronLeft, ChevronRight, Loader, RefreshCw } from "lucide-react";
import { readMeta, versionPatch } from "../generation";
import type { GenerationMeta, GenerationNode } from "../generation";
import { useRuntimeStore } from "../runtimeStore";
import { regenerateNode } from "../canvasGenerate";

/**
 * 节点底部的生成状态条（PLAN 3.4 / 3.5，对标 `data-canvas-generation-version`
 * 与 `data-canvas-generation-state`）。
 *
 * 一个节点能显示：生成中（转圈）/ 失败（原因 + 重试）/ 第几版（可前后切换）。
 * 切换版本是纯本地操作（把某一版的内容字段写回节点），不重新调模型。
 */
export default function NodeGenerationBar({ node }: { node: GenerationNode }) {
  const [busy, setBusy] = useState(false);
  const patchNodeData = useRuntimeStore((s) => s.patchNodeData);
  const commitHistory = useRuntimeStore((s) => s.commitHistory);

  const meta = useMemo(() => readMeta(node), [node]);

  if (!meta || meta.versions.length === 0) return null;

  const index = Math.max(1, meta.versions.findIndex((v) => v.id === meta.activeVersion) + 1);
  const total = meta.versions.length;

  const switchTo = (versionId: string) => {
    const patch = versionPatch(node, versionId);
    if (!patch) return;
    commitHistory();
    const next: GenerationMeta = { ...meta, activeVersion: versionId, status: "done" };
    patchNodeData(node.id, { ...patch, generation: next });
  };

  const step = (delta: number) => {
    const next = meta.versions[index - 1 + delta];
    if (next) switchTo(next.id);
  };

  const retry = async () => {
    setBusy(true);
    try {
      await regenerateNode(node.id);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="nv-genbar nodrag">
      {meta.status === "generating" ? (
        <span className="nv-gen-state is-busy">
          <Loader size={11} className="nv-spin" /> 生成中…
        </span>
      ) : meta.status === "failed" ? (
        <span className="nv-gen-state is-failed" title={meta.error}>
          <AlertTriangle size={11} /> {meta.error?.slice(0, 40) ?? "失败"}
        </span>
      ) : (
        <span className="nv-gen-state" title={meta.prompt ?? ""}>
          第 {index}/{total} 版
        </span>
      )}

      {total > 1 ? (
        <span className="nv-gen-nav">
          <button className="nv-btn" disabled={index <= 1} onClick={() => step(-1)} title="上一版">
            <ChevronLeft size={11} />
          </button>
          <button className="nv-btn" disabled={index >= total} onClick={() => step(1)} title="下一版">
            <ChevronRight size={11} />
          </button>
        </span>
      ) : null}

      <button className="nv-btn nv-gen-retry" disabled={busy} onClick={() => void retry()} title="重新生成">
        <RefreshCw size={11} className={busy ? "nv-spin" : ""} />
      </button>
    </div>
  );
}
