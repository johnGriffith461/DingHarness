import { useState } from "react";
import {
  ChevronDown,
  Circle,
  Code2,
  CodeXml,
  Download,
  FolderOpen,
  Frame,
  History,
  ImagePlus,
  Keyboard,
  Layers,
  Maximize2,
  Network,
  Plus,
  Radio,
  RotateCcw,
  Sparkles,
  Square,
  SquarePen,
  Type,
} from "lucide-react";
import { NODE_KIND_META, type NodeKind } from "./types";
import { INTENT_META, type GenerateIntent } from "./canvasGenerate";
import { shortcutCheatsheet } from "./shortcuts";

/**
 * 顶部工具条：**往画布上加东西 / 看状态**的那些工具
 * （新建节点、AI 生成、适应视图、快捷键、图层、版本历史、导出）。
 *
 * 「选择方式」与「撤销·重做·缩放」在**底部工具条**里（对标原版
 * `data-canvas-bottom-toolbar` 的形态）—— 那是对着画面操作的工具，跟"新建一个节点"不是一类。
 *
 * `nodrag` 只加在控件上（加到容器上会连 React Flow 自己的节点拖拽一起废掉）。
 */

/** 每种节点类型在「新建」菜单里的图标。 */
const KIND_ICON: Record<NodeKind, typeof Type> = {
  markdown: Type,
  code: Code2,
  image: ImagePlus,
  mindmap: Network,
  mermaid: Radio,
  whiteboard: SquarePen,
  rect: Square,
  ellipse: Circle,
  frame: Frame,
  html: CodeXml,
};

export type CanvasToolbarProps = {
  /** 在视口中心落一个指定类型的新节点。 */
  onAddNode: (kind: NodeKind) => void;
  /** 当前选中的节点数（决定 AI 生成是否可用）。 */
  selectionCount: number;
  /** 用选中素材生成新节点。 */
  onGenerate: (intent: GenerateIntent, instruction: string) => void;
  onFitView: () => void;
  onReset: () => void;
  /** 版本历史面板是否打开。 */
  versionsOpen: boolean;
  /** 切换版本历史面板。 */
  onToggleVersions: () => void;
  /** 图层面板是否打开。 */
  layersOpen: boolean;
  /** 切换图层面板。 */
  onToggleLayers: () => void;
  /** 导出：当前视图 / 选中画框 / 打开导出目录。 */
  onExport: (scope: "view" | "frame" | "reveal") => void;
};

/** 极简下拉管理：同一时刻只开一个菜单。 */
type OpenMenu = "add" | "ai" | "export" | null;

export default function CanvasToolbar({
  onAddNode,
  selectionCount,
  onGenerate,
  onFitView,
  onReset,
  versionsOpen,
  onToggleVersions,
  layersOpen,
  onToggleLayers,
  onExport,
}: CanvasToolbarProps) {
  const [open, setOpen] = useState<OpenMenu>(null);
  const [instruction, setInstruction] = useState("");
  /** 快捷键说明面板。 */
  const [cheatsheetOpen, setCheatsheetOpen] = useState(false);

  return (
    <div
      className="canvas-toolbar nodrag"
      onMouseDown={(e) => {
        /**
         * 点工具条空白处收起菜单。
         *
         * ⚠️ 必须把**两种**菜单容器都算作"里面"：`.canvas-menu-wrap`（新建 / AI 生成）
         * 和 `.canvas-toolbar-menu`（快捷键 / 导出）。
         * 早期只认了前者，结果导出菜单在 **mousedown 的瞬间就被收起**，
         * 菜单项被移出 DOM，click 事件永远落不到它身上 ——
         * 表现是"点导出没反应、也没有任何提示"（实测踩过）。
         */
        const target = e.target as HTMLElement;
        if (!target.closest(".canvas-menu-wrap") && !target.closest(".canvas-toolbar-menu")) {
          setOpen(null);
        }
      }}
    >
      {/*
       * 顶部只放"往画布上加东西 / 看状态"的工具。
       * 「选择方式」和「撤销·重做」已经挪到**底部工具条**（对标原版
       * `data-canvas-bottom-toolbar` 的形态）—— 那是对着画面操作的工具，
       * 跟"新建一个节点"不是一类；放在一起既挤又容易和标记条重叠。
       */}

      <div className="canvas-menu-wrap">
        <button
          className={open === "add" ? "on" : ""}
          onClick={() => setOpen((v) => (v === "add" ? null : "add"))}
          title="在视口中心新建节点"
          data-testid="add-node"
        >
          <Plus size={15} />
          新建
          <ChevronDown size={13} />
        </button>
        {open === "add" ? (
          <div className="canvas-menu" role="menu">
            {(Object.keys(NODE_KIND_META) as NodeKind[]).map((kind) => {
              const meta = NODE_KIND_META[kind];
              const Icon = KIND_ICON[kind];
              return (
                <button
                  key={kind}
                  role="menuitem"
                  data-kind={kind}
                  onClick={() => {
                    onAddNode(kind);
                    setOpen(null);
                  }}
                >
                  <Icon size={14} />
                  <span className="canvas-menu-label">{meta.label}</span>
                  <span className="canvas-menu-hint">{meta.hint}</span>
                </button>
              );
            })}
          </div>
        ) : null}
      </div>

      <div className="canvas-menu-wrap">
        <button
          className={open === "ai" ? "on" : ""}
          disabled={selectionCount === 0}
          onClick={() => setOpen((v) => (v === "ai" ? null : "ai"))}
          title={
            selectionCount === 0 ? "先在画布上选中素材，再生成" : `用选中的 ${selectionCount} 个节点生成新内容`
          }
          data-testid="ai-generate"
        >
          <Sparkles size={15} />
          AI 生成
          {selectionCount > 0 ? <span className="canvas-badge">{selectionCount}</span> : null}
        </button>
        {open === "ai" ? (
          <div className="canvas-menu canvas-menu-ai" role="menu">
            <input
              className="canvas-menu-input"
              placeholder="要求（可留空，例如：整理成要点）"
              value={instruction}
              onChange={(e) => setInstruction(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  onGenerate("write", instruction);
                  setOpen(null);
                }
              }}
            />
            {(Object.keys(INTENT_META) as GenerateIntent[]).map((intent) => {
              const meta = INTENT_META[intent];
              return (
                <button
                  key={intent}
                  role="menuitem"
                  data-intent={intent}
                  onClick={() => {
                    onGenerate(intent, instruction);
                    setOpen(null);
                  }}
                >
                  <Sparkles size={14} />
                  <span className="canvas-menu-label">{meta.label}</span>
                  <span className="canvas-menu-hint">{meta.hint}</span>
                </button>
              );
            })}
          </div>
        ) : null}
      </div>

      <span className="canvas-toolbar-sep" />

      <button onClick={onFitView} aria-label="适配视图" title="适配视图（一键全览） Ctrl+0">
        <Maximize2 size={15} />
      </button>
      <button onClick={onReset} aria-label="回到示例画布" title="回到示例画布">
        <RotateCcw size={15} />
      </button>

      <span className="canvas-toolbar-sep" />

      <div className="canvas-toolbar-menu">
        <button
          className={cheatsheetOpen ? "is-open" : ""}
          data-testid="shortcut-help"
          aria-label="看全部快捷键" title="看全部快捷键"
          onClick={() => setCheatsheetOpen((prev) => !prev)}
        >
          <Keyboard size={15} />
        </button>
        {cheatsheetOpen ? (
          <div className="canvas-menu canvas-shortcuts" data-testid="shortcut-cheatsheet">
            <div className="canvas-menu-title">快捷键</div>
            {shortcutCheatsheet().map((item) => (
              <div className="shortcut-row" key={item.keys}>
                <kbd>{item.keys}</kbd>
                <span>{item.label}</span>
              </div>
            ))}
            <div className="canvas-menu-hint">
              标记：拖拽画图形，按住 Alt 可连续标注；点空白或按 Esc 退出标记模式。
            </div>
          </div>
        ) : null}
      </div>

      <div className="canvas-toolbar-menu">
        <button
          className={open === "export" ? "on" : ""}
          data-testid="export-menu"
          aria-label="导出" title="导出（走主进程截屏，所见即所得；想要更清晰先把画布放大）"
          onClick={() => setOpen((v) => (v === "export" ? null : "export"))}
        >
          <Download size={15} />
          <ChevronDown size={11} />
        </button>
        {open === "export" ? (
          <div className="canvas-menu" data-testid="export-options" onMouseLeave={() => setOpen(null)}>
            <button
              data-testid="export-view"
              onClick={() => {
                onExport("view");
                setOpen(null);
              }}
            >
              <ImagePlus size={13} />
              <span>
                <b>导出当前视图</b>
                <em>导出整个可视画布区</em>
              </span>
            </button>
            <button
              data-testid="export-frame"
              onClick={() => {
                onExport("frame");
                setOpen(null);
              }}
            >
              <Frame size={13} />
              <span>
                <b>导出选中画框</b>
                <em>没选中就用第一个画框</em>
              </span>
            </button>
            <button
              data-testid="reveal-exports"
              onClick={() => {
                onExport("reveal");
                setOpen(null);
              }}
            >
              <FolderOpen size={13} />
              <span>
                <b>打开导出目录</b>
                <em>导出的 PNG 都在这儿</em>
              </span>
            </button>
          </div>
        ) : null}
      </div>

      <button
        data-testid="open-layers"
        className={layersOpen ? "is-open" : ""}
        aria-label="图层面板" title="图层面板（按顺序管理画布上的每一层）"
        onClick={onToggleLayers}
      >
        <Layers size={15} />
      </button>

      <button
        data-testid="open-versions"
        className={versionsOpen ? "is-open" : ""}
        aria-label="版本历史" title="版本历史（每次变更自动存一版，可恢复）"
        onClick={onToggleVersions}
      >
        <History size={15} />
      </button>
    </div>
  );
}
