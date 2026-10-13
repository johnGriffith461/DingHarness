import { useState } from "react";
import {
  Clapperboard,
  Hand,
  ImagePlus,
  Maximize2,
  MousePointer2,
  Paintbrush,
  Redo2,
  Undo2,
} from "lucide-react";
import { useViewport } from "@xyflow/react";
import type { SelectionMode } from "./selection";

/**
 * 底部工具条（阶段 9.2，对标原版 `data-canvas-bottom-toolbar`）。
 *
 * 原版把"选择 / 标记 / 图片生成 / 视频生成"和"撤销 / 重做 / 缩放%"放在**画布底部**，
 * 顶部留给任务与创建类操作。我们之前把模式切换放在顶部居中，
 * 结果和标记工具条挤在一起（实测重叠 586×34px，见 `HANDOFF.md` §19.3）。
 * 现在按原版的形态拆开：**底部放"对着画面操作"的工具，顶部放"往画布上加东西"的工具**。
 */

const MODE_META: Record<SelectionMode, { label: string; icon: typeof MousePointer2; hint: string }> = {
  box: { label: "框选", icon: Maximize2, hint: "空白处拖拽拉框，框内节点入选" },
  point: { label: "点选", icon: MousePointer2, hint: "单击选中，点空白取消选择" },
  smear: { label: "涂抹选", icon: Paintbrush, hint: "按住划过，路径经过的节点入选" },
  pan: { label: "平移", icon: Hand, hint: "空白处拖拽平移画布" },
};

export type BottomToolbarProps = {
  mode: SelectionMode;
  onModeChange: (mode: SelectionMode) => void;
  markerMode: boolean;
  onToggleMarkerMode: () => void;
  markerCount: number;
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
  /** 生成面板当前开着哪一个（null = 都关着）。 */
  genKind: "image" | "video" | null;
  onOpenGen: (kind: "image" | "video") => void;
};

export default function BottomToolbar({
  mode,
  onModeChange,
  markerMode,
  onToggleMarkerMode,
  markerCount,
  canUndo,
  canRedo,
  onUndo,
  onRedo,
  genKind,
  onOpenGen,
}: BottomToolbarProps) {
  const [modeOpen, setModeOpen] = useState(false);
  // 缩放从视口读，跟状态栏同一个来源（免得两处各算一遍再对不上）
  const { zoom } = useViewport();

  return (
    <div className="bottom-toolbar nodrag" data-canvas-bottom-toolbar data-testid="bottom-toolbar">
      {/* 选择：当前模式显示成一个按钮，点开才是四选一（省底部空间） */}
      <div className="bottom-menu">
        <button
          className="bottom-btn is-primary"
          data-testid="bottom-select"
          title="选择方式"
          onClick={() => setModeOpen((v) => !v)}
        >
          {(() => {
            const Icon = MODE_META[mode].icon;
            return <Icon size={14} />;
          })()}
          {MODE_META[mode].label}
        </button>
        {modeOpen ? (
          <div className="bottom-menu-pop" data-testid="bottom-modes" onMouseLeave={() => setModeOpen(false)}>
            {(Object.keys(MODE_META) as SelectionMode[]).map((m) => {
              const Icon = MODE_META[m].icon;
              return (
                <button
                  key={m}
                  className={`canvas-mode${mode === m ? " on" : ""}`}
                  data-mode={m}
                  title={MODE_META[m].hint}
                  onClick={() => {
                    onModeChange(m);
                    setModeOpen(false);
                  }}
                >
                  <Icon size={13} />
                  {MODE_META[m].label}
                </button>
              );
            })}
          </div>
        ) : null}
      </div>

      <button
        className={`bottom-btn${markerMode ? " is-active" : ""}`}
        data-testid="bottom-marker"
        title="标记：在画面上画框/圈选/箭头…，然后把标记当提示词发给 AI"
        onClick={onToggleMarkerMode}
      >
        <Paintbrush size={14} />
        标记
        {markerCount > 0 ? <em className="bottom-badge">{markerCount}</em> : null}
      </button>

      <span className="bottom-sep" />

      <button
        className={`bottom-btn${genKind === "image" ? " is-active" : ""}`}
        data-testid="bottom-image-gen"
        title="图片生成：描述画面 → 生成图片 → 直接落成画布节点"
        onClick={() => onOpenGen("image")}
      >
        <ImagePlus size={14} />
        图片生成
      </button>
      <button
        className={`bottom-btn${genKind === "video" ? " is-active" : ""}`}
        data-testid="bottom-video-gen"
        title="视频生成"
        onClick={() => onOpenGen("video")}
      >
        <Clapperboard size={14} />
        视频生成
      </button>

      <span className="bottom-sep" />

      <button className="bottom-btn is-icon" data-testid="bottom-undo" disabled={!canUndo} onClick={onUndo} title="撤销 Ctrl+Z">
        <Undo2 size={14} />
      </button>
      <button className="bottom-btn is-icon" data-testid="bottom-redo" disabled={!canRedo} onClick={onRedo} title="重做 Ctrl+Shift+Z">
        <Redo2 size={14} />
      </button>

      <span className="bottom-zoom" title="当前缩放">
        {(zoom * 100).toFixed(0)}%
      </span>
    </div>
  );
}
