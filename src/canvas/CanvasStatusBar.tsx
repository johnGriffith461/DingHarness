import { useViewport } from "@xyflow/react";
import { AlertTriangle, Check, Cloud, Loader, MousePointer2 } from "lucide-react";
import type { SaveState } from "./usePersistence";

/**
 * 画布状态栏（对标原版画布右下角的状态条）：节点数 / 连线数 / 保存状态 / 缩放 / 修订号。
 *
 * 缩放与视口都从 React Flow 的 store 读取，不经过自研 store —— 平移缩放属于视图态，
 * 不是画布内容，避免每帧平移都推高修订号。
 */
export default function CanvasStatusBar({
  nodeCount,
  edgeCount,
  selectedCount,
  markerCount,
  revision,
  saveState,
}: {
  nodeCount: number;
  edgeCount: number;
  selectedCount: number;
  /** 标记数量（阶段 5 的标记层）。 */
  markerCount?: number;
  revision?: number;
  /** 保存状态（未接 Electron 时传 undefined，状态栏就不显示这一项）。 */
  saveState?: SaveState;
}) {
  const { zoom } = useViewport();

  return (
    <div className="canvas-statusbar">
      <span>节点 {nodeCount}</span>
      <span className="dot" />
      <span>连线 {edgeCount}</span>
      <span className="dot" />
      <span className="status-sel">
        <MousePointer2 size={11} /> 选中 {selectedCount}
      </span>
      {typeof markerCount === "number" && markerCount > 0 ? (
        <>
          <span className="dot" />
          <span className="status-marker" title="画布上的标记数量">
            标记 {markerCount}
          </span>
        </>
      ) : null}
      <span className="dot" />
      <span>缩放 {(zoom * 100).toFixed(0)}%</span>
      {saveState ? (
        <>
          <span className="dot" />
          <span className={`status-save is-${saveState}`} title="画布自动保存状态">
            {saveState === "saved" ? (
              <>
                <Check size={11} /> 已保存
              </>
            ) : saveState === "saving" ? (
              <>
                <Loader size={11} className="nv-spin" /> 保存中
              </>
            ) : saveState === "error" ? (
              <>
                <AlertTriangle size={11} /> 保存失败
              </>
            ) : (
              <>
                <Cloud size={11} /> 未保存
              </>
            )}
          </span>
        </>
      ) : null}
      {typeof revision === "number" ? (
        <>
          <span className="dot" />
          <span className="status-rev" title="修订号：画布每次内容变更 +1（对标原版 documentRevision）">
            rev {revision}
          </span>
        </>
      ) : null}
    </div>
  );
}
