import { useCallback, useEffect, useRef, useState } from "react";
import {
  Code2,
  Copy,
  Eye,
  EyeOff,
  FlipHorizontal2,
  FlipVertical2,
  Image as ImageIcon,
  Layers,
  Lock,
  LockOpen,
  Network,
  Paintbrush,
  SendToBack,
  SquarePen,
  Trash2,
  Type,
  X,
} from "lucide-react";
import { useRuntimeStore } from "./runtimeStore";
import type { NodeKind } from "./types";
import { NODE_KIND_META } from "./types";
import { canFlip, canReorder, toLayerRows, type LayerOrderOp } from "./layers";

/**
 * 图层面板（阶段 8.1 / 8.2，对标原版 `data-canvas-order` 与
 * `aiCreation_canvas_layerContext_*`）。
 *
 * 这是把画布从"卡片墙"变成"设计工作区"的那一步：所有内容按 z 序排成一列，
 * 能选中、能显隐、能锁定、能调层次，右键还能上移/下移/置顶/置底/翻转/复制/删。
 *
 * 面板里的顺序是**从顶到底**（最上面那层排第一），而 store 里的数组是**从底到顶** ——
 * 两个方向都收在 `layers.ts` 里，界面不做二次换算，免得两处各写一套再对不上。
 */
export default function LayerPanel({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const nodes = useRuntimeStore((s) => s.nodes);
  const reorderLayer = useRuntimeStore((s) => s.reorderLayer);
  const setLayerHidden = useRuntimeStore((s) => s.setLayerHidden);
  const setLayerLocked = useRuntimeStore((s) => s.setLayerLocked);
  const flipLayer = useRuntimeStore((s) => s.flipLayer);
  const selectNodes = useRuntimeStore((s) => s.selectNodes);
  const duplicateSelected = useRuntimeStore((s) => s.duplicateSelected);
  const removeSelected = useRuntimeStore((s) => s.removeSelected);
  const commitHistory = useRuntimeStore((s) => s.commitHistory);

  /** 右键菜单：锚定在哪一层、显示在什么位置。 */
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);

  const rows = toLayerRows(nodes);
  const order = nodes.map((n) => n.id);

  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    window.addEventListener("mousedown", close);
    window.addEventListener("blur", close);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("blur", close);
    };
  }, [menu]);

  const pick = useCallback(
    (id: string) => {
      // 点图层 = 只选中它（设计工具里的习惯：点哪层就编哪层）
      selectNodes([id]);
    },
    [selectNodes],
  );

  const onOrder = useCallback(
    (id: string, op: LayerOrderOp) => {
      commitHistory();
      reorderLayer(id, op);
    },
    [commitHistory, reorderLayer],
  );

  if (!open) return null;

  const kindIcon = (kind: string) => {
    switch (kind as NodeKind) {
      case "code":
        return <Code2 size={11} />;
      case "image":
        return <ImageIcon size={11} />;
      case "mindmap":
        return <Network size={11} />;
      case "mermaid":
        return <SquarePen size={11} />;
      case "whiteboard":
        return <Paintbrush size={11} />;
      default:
        return <Type size={11} />;
    }
  };

  const menuNode = menu ? nodes.find((n) => n.id === menu.id) : null;
  const menuKind = (menuNode?.type ?? "") as string;

  return (
    <div className="layer-panel" data-testid="layer-panel" ref={panelRef}>
      <div className="layer-head">
        <span className="layer-title">
          <Layers size={13} /> 图层
          <em>{rows.length}</em>
        </span>
        <button className="layer-icon" onClick={onClose} title="关闭图层面板">
          <X size={13} />
        </button>
      </div>

      <div className="layer-list" data-testid="layer-list">
        {rows.length === 0 ? <div className="layer-empty">画布上还没有内容</div> : null}
        {rows.map((row) => (
          <div
            key={row.id}
            className={`layer-row${row.selected ? " is-selected" : ""}${row.hidden ? " is-hidden" : ""}${
              row.locked ? " is-locked" : ""
            }`}
            data-layer-id={row.id}
            data-layer-order={row.order}
            onClick={() => pick(row.id)}
            onContextMenu={(e) => {
              e.preventDefault();
              pick(row.id);
              setMenu({ id: row.id, x: e.clientX, y: e.clientY });
            }}
            title="左键选中，右键打开图层菜单"
          >
            <span className="layer-kind">{kindIcon(row.kind)}</span>
            <span className="layer-name">
              {row.label}
              <em>{NODE_KIND_META[row.kind as NodeKind]?.label ?? row.kind}</em>
            </span>
            <button
              className="layer-icon"
              data-layer-lock={row.id}
              title={row.locked ? "解锁这一层（恢复可拖动）" : "锁定这一层（防止误拖）"}
              onClick={(e) => {
                e.stopPropagation();
                setLayerLocked(row.id, !row.locked);
              }}
            >
              {row.locked ? <Lock size={11} /> : <LockOpen size={11} />}
            </button>
            <button
              className="layer-icon"
              data-layer-eye={row.id}
              title={row.hidden ? "显示这一层" : "隐藏这一层"}
              onClick={(e) => {
                e.stopPropagation();
                setLayerHidden(row.id, !row.hidden);
              }}
            >
              {row.hidden ? <EyeOff size={11} /> : <Eye size={11} />}
            </button>
          </div>
        ))}
      </div>

      {menu && menuNode ? (
        <div
          className="layer-menu"
          data-testid="layer-menu"
          style={{ left: menu.x, top: menu.y }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <button
            className="layer-menu-item"
            data-layer-op="front"
            disabled={!canReorder(order, menu.id, "front")}
            onClick={() => {
              onOrder(menu.id, "front");
              setMenu(null);
            }}
          >
            置顶
          </button>
          <button
            className="layer-menu-item"
            data-layer-op="forward"
            disabled={!canReorder(order, menu.id, "forward")}
            onClick={() => {
              onOrder(menu.id, "forward");
              setMenu(null);
            }}
          >
            上移一层
          </button>
          <button
            className="layer-menu-item"
            data-layer-op="backward"
            disabled={!canReorder(order, menu.id, "backward")}
            onClick={() => {
              onOrder(menu.id, "backward");
              setMenu(null);
            }}
          >
            下移一层
          </button>
          <button
            className="layer-menu-item"
            data-layer-op="back"
            disabled={!canReorder(order, menu.id, "back")}
            onClick={() => {
              onOrder(menu.id, "back");
              setMenu(null);
            }}
          >
            置底
          </button>

          <div className="layer-menu-sep" />

          <button
            className="layer-menu-item"
            data-layer-op="flip-h"
            disabled={!canFlip(menuKind)}
            title={canFlip(menuKind) ? "水平翻转" : "这一层没有画面内容，无法翻转"}
            onClick={() => {
              commitHistory();
              flipLayer(menu.id, "horizontal");
              setMenu(null);
            }}
          >
            <FlipHorizontal2 size={12} /> 水平翻转
          </button>
          <button
            className="layer-menu-item"
            data-layer-op="flip-v"
            disabled={!canFlip(menuKind)}
            title={canFlip(menuKind) ? "垂直翻转" : "这一层没有画面内容，无法翻转"}
            onClick={() => {
              commitHistory();
              flipLayer(menu.id, "vertical");
              setMenu(null);
            }}
          >
            <FlipVertical2 size={12} /> 垂直翻转
          </button>

          <div className="layer-menu-sep" />

          <button
            className="layer-menu-item"
            data-layer-op="duplicate"
            onClick={() => {
              commitHistory();
              duplicateSelected();
              setMenu(null);
            }}
          >
            <Copy size={12} /> 复制一份
          </button>
          <button
            className="layer-menu-item"
            data-layer-op="send-back"
            title="放到最底层"
            onClick={() => {
              onOrder(menu.id, "back");
              setMenu(null);
            }}
          >
            <SendToBack size={12} /> 放到最底层
          </button>
          <button
            className="layer-menu-item is-danger"
            data-layer-op="delete"
            onClick={() => {
              commitHistory();
              removeSelected();
              setMenu(null);
            }}
          >
            <Trash2 size={12} /> 删除这一层
          </button>
        </div>
      ) : null}
    </div>
  );
}
