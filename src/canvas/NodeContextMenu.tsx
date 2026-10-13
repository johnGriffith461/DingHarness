import type { ReactNode } from "react";
import { useEffect } from "react";
import {
  ArrowDown,
  ArrowUp,
  ChevronsDown,
  ChevronsUp,
  Copy,
  Eye,
  FlipHorizontal2,
  FlipVertical2,
  Lock,
  Trash2,
} from "lucide-react";
import { useRuntimeStore } from "./runtimeStore";
import { canFlip, type LayerOrderOp } from "./layers";

/**
 * 画布节点的右键菜单（阶段 11.28）。
 *
 * ## 为什么这件必须补
 * 画布这类应用里，右键节点什么都不发生是**明显的缺失** —— 而 Electron 里
 * 右键还会被系统菜单接管。用户在画布上试右键是必然的事。
 *
 * ## 每一项都对应一个已有操作
 * 这里**不新增能力**，只是把底部工具条/图层面板里已经有的操作挪一份到右键上
 * （复制、删除、锁定、隐藏、层级四档、水平/垂直翻转）。
 * 菜单里出现一个工具条里做不到的项，就等于多了一条只有右键能走的路。
 *
 * ## 与实机的关系
 * 我**没有实机这一处菜单的截图**（遍历时没能进到真画布）。所以这一项的
 * 动作集合是我按"画布类应用的常规"定的，**不是**从实机抄来的 ——
 * 记在这里，免得后面把它当成已核对的保真项。
 */

/** 菜单项。 */
type Item = { label: string; icon?: ReactNode; run: () => void; danger?: boolean; disabled?: string };

/**
 * 在指定位置弹出节点右键菜单。
 *
 * @param props.nodeId 目标节点
 * @param props.x 视口 x
 * @param props.y 视口 y
 * @param props.onClose 关闭回调
 */
export default function NodeContextMenu({
  nodeId,
  x,
  y,
  onClose,
}: {
  nodeId: string;
  x: number;
  y: number;
  onClose: () => void;
}) {
  const store = useRuntimeStore;

  useEffect(() => {
    const close = () => onClose();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("mousedown", close);
    /*
     * ⚠️ **必须用捕获阶段**：画布里 React Flow 自己也处理按键（它有 tabIndex 的
     * pane 在监听 keydown），Escape 会被它先吃到，冒泡阶段就轮不到我们了 ——
     * 实测表现为"按 Esc 菜单关不掉"。捕获阶段先于任何冒泡处理器触发。
     */
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("scroll", close, true);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("scroll", close, true);
    };
  }, [onClose]);

  /**
   * 先把目标选中，再执行动作。
   *
   * 所有项都走这一步：**对某个节点做了操作，它就应该是当前选中项**。
   * 不选中的话，操作完画布上看不出"动的是哪一个"（改完层级、隐藏完，
   * 用户还得回想刚才点的是哪个节点）。
   */
  const on = (run: () => void) => () => {
    store.getState().selectNodes([nodeId]);
    run();
  };

  const node = store.getState().nodes.find((n) => n.id === nodeId);
  const data = (node?.data ?? {}) as { locked?: boolean; hidden?: boolean };
  /** 节点类型：翻转能不能用由它决定（与图层面板同一套规则）。 */
  const kind = String(node?.type ?? "");

  const order = (op: LayerOrderOp) => on(() => store.getState().reorderLayer(nodeId, op));

  const items: Item[] = [
    { label: "复制", icon: <Copy size={13} />, run: on(() => store.getState().duplicateSelected(24)) },
    { label: "删除", icon: <Trash2 size={13} />, danger: true, run: on(() => store.getState().removeSelected()) },
    {
      label: data.locked ? "解锁" : "锁定",
      icon: <Lock size={13} />,
      run: on(() => store.getState().setLayerLocked(nodeId, !data.locked)),
    },
    {
      label: data.hidden ? "显示" : "隐藏",
      icon: <Eye size={13} />,
      run: on(() => store.getState().setLayerHidden(nodeId, !data.hidden)),
    },
    { label: "上移一层", icon: <ArrowUp size={13} />, run: order("forward") },
    { label: "下移一层", icon: <ArrowDown size={13} />, run: order("backward") },
    { label: "移到最前", icon: <ChevronsUp size={13} />, run: order("front") },
    { label: "移到最后", icon: <ChevronsDown size={13} />, run: order("back") },
    /*
     * 翻转**必须按 `canFlip` 收口**：`flipTransform` 目前只有形状节点在渲染，
     * 文本/代码这类节点设了 `flipX` 是没有任何变化的。
     * 不收口的话，菜单项看着有、点了没反应 —— 那正是这个项目一直在清的那类问题。
     * 规则与文案跟图层面板完全一致，两处不该各说各话。
     */
    {
      label: "水平翻转",
      icon: <FlipHorizontal2 size={13} />,
      disabled: canFlip(kind) ? undefined : "这一层没有画面内容，无法翻转",
      run: on(() => store.getState().flipLayer(nodeId, "horizontal")),
    },
    {
      label: "垂直翻转",
      icon: <FlipVertical2 size={13} />,
      disabled: canFlip(kind) ? undefined : "这一层没有画面内容，无法翻转",
      run: on(() => store.getState().flipLayer(nodeId, "vertical")),
    },
  ];

  /** 靠右下角弹的菜单会跑出窗口，夹一下。 */
  const left = Math.max(4, Math.min(x, window.innerWidth - 190));
  const top = Math.max(4, Math.min(y, window.innerHeight - 10 * 32 - 8));

  return (
    <div className="cv-ctx" data-testid="cv-node-menu" style={{ left, top }} onMouseDown={(e) => e.stopPropagation()}>
      {items.map((item) => (
        <button
          key={item.label}
          className={`cv-ctx-item${item.danger ? " is-danger" : ""}${item.disabled ? " is-off" : ""}`}
          data-testid={`cv-ctx-${item.label}`}
          title={item.disabled ?? ""}
          disabled={Boolean(item.disabled)}
          onClick={() => {
            item.run();
            onClose();
          }}
        >
          <span className="cv-ctx-icon">{item.icon}</span>
          {item.label}
        </button>
      ))}
    </div>
  );
}
