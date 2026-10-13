import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Check, Crop, ImagePlus, RotateCcw, Wand2, X } from "lucide-react";
import type { NodeProps } from "@xyflow/react";
import type { ImageNode as ImageNodeType } from "../types";
import { NodeView } from "./NodeView";
import NodeGenerationBar from "./NodeGenerationBar";
import { useNodeActions } from "../useNodeActions";
import { clampCrop, cropStyle, cropToPercent, isFullCrop, loadImage, percentToCrop, readAsDataUrl } from "./imageCrop";
import { IMAGE_ACTIONS, imageAction, targetSizeFor, type ImageActionId } from "../imageActions";
import { editImage, humanImageError } from "@/ai/imageClient";
import { normalize } from "@shared/imageSize";

/**
 * 图片节点（PLAN 2.3）：上传 / 预览 / 裁剪 / 复原。
 *
 * 裁剪交互没用 react-easy-crop 的现成组件，而是自己在原图上画一个可拖拽的选择框：
 * 现成组件的交互是"固定框 + 移动底图"，落到画布节点里会与画布本身的拖拽/缩放打架
 * （平移手势会被节点吃掉）。自绘选择框只需处理自身内部坐标，边界清楚，也不额外引依赖。
 *
 * 裁剪结果存**原图坐标**（见 `imageCrop.ts`），展示时靠样式对位，不重采样。
 */

/** 超过这个体积就先只做内联预览，落盘交给主进程（阶段 2 的 IPC 通道）。 */
const MAX_INLINE_BYTES = 12 * 1024 * 1024;

type DragState = {
  /** 正在移动整个框，还是拖某个角。 */
  mode: "move" | "nw" | "ne" | "sw" | "se";
  startX: number;
  startY: number;
  origin: { x: number; y: number; width: number; height: number };
};

export default function ImageNodeView({ id, data, selected }: NodeProps<ImageNodeType>) {
  const { beginEdit, setData } = useNodeActions();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cropping, setCropping] = useState(false);
  const [draftCrop, setDraftCrop] = useState(data.crop ?? null);
  const dragRef = useRef<DragState | null>(null);

  /** 图片动作菜单是否打开（对标 `aiCreation_canvas_imageAction_*`）。 */
  const [actionOpen, setActionOpen] = useState(false);
  /** 自由编辑那一项的输入。 */
  const [instruction, setInstruction] = useState("");
  /** 正在跑的动作 id（用于在按钮上显示"改图中"）。 */
  const [running, setRunning] = useState<ImageActionId | null>(null);

  const natural = data.natural;
  const cropped = !isFullCrop(data.crop, natural);

  /**
   * 跑一个图片动作：把当前这张图 + 提示词发给图生图，**改掉这一张**。
   *
   * 为什么是"改掉"而不是"另开一张"：抠图/增强的语义就是处理这一张；
   * 另开一张会让画布上堆一串半成品。要保留原图的话，Ctrl+Z 能整体退回去
   * （跑之前记了历史）。
   */
  const runAction = useCallback(
    async (actionId: ImageActionId) => {
      const action = imageAction(actionId);
      if (!action || !data.src || running) return;
      if (action.needsInstruction && !instruction.trim()) {
        setError("先写一句你想怎么改");
        return;
      }

      setRunning(actionId);
      setError(null);
      beginEdit(id);

      const size = targetSizeFor(
        action,
        natural ? { w: natural.width, h: natural.height } : undefined,
        normalize,
      );
      const outcome = await editImage(data.src, action.prompt({ instruction }), undefined, size);

      setRunning(null);
      if (!outcome.ok) {
        setError(humanImageError(outcome.error));
        return;
      }
      setActionOpen(false);
      setInstruction("");
      // 换掉图，并清掉裁剪（尺寸变了，旧裁剪框会错位）
      setData(id, {
        src: outcome.url,
        filePath: outcome.name,
        crop: undefined,
        generatedBy: outcome.model,
      });
      setDraftCrop(null);
    },
    [beginEdit, data.src, id, instruction, natural, running, setData],
  );

  useEffect(() => {
    if (!cropping) setDraftCrop(data.crop ?? null);
  }, [cropping, data.crop]);

  const pick = () => inputRef.current?.click();

  const onFile = useCallback(
    async (file: File | undefined) => {
      if (!file) return;
      if (!file.type.startsWith("image/")) {
        setError("只支持图片文件");
        return;
      }
      if (file.size > MAX_INLINE_BYTES) {
        setError("图片超过 12MB，请先压缩");
        return;
      }
      setError(null);
      setBusy(true);
      try {
        const src = await readAsDataUrl(file);
        const img = await loadImage(src);
        beginEdit(id);
        setData(id, {
          src,
          alt: file.name,
          natural: { width: img.naturalWidth, height: img.naturalHeight },
          crop: { x: 0, y: 0, width: img.naturalWidth, height: img.naturalHeight },
        });
      } catch (e) {
        setError(e instanceof Error ? e.message : "读取失败");
      } finally {
        setBusy(false);
      }
    },
    [beginEdit, id, setData],
  );

  /** 裁剪框：用百分比定位，避免容器尺寸变化时坐标漂移。 */
  const cropPercent = useMemo(() => {
    if (!natural) return { x: 0, y: 0, width: 100, height: 100 };
    const c = draftCrop ?? { x: 0, y: 0, width: natural.width, height: natural.height };
    return cropToPercent(c, natural);
  }, [draftCrop, natural]);

  const applyDrag = useCallback(
    (clientX: number, clientY: number) => {
      const drag = dragRef.current;
      const stage = stageRef.current;
      if (!drag || !stage || !natural) return;
      const rect = stage.getBoundingClientRect();
      const dx = ((clientX - drag.startX) / rect.width) * 100;
      const dy = ((clientY - drag.startY) / rect.height) * 100;
      const o = drag.origin;
      const min = 5; // 最小 5% 边
      let next = { ...o };

      if (drag.mode === "move") {
        next.x = Math.min(100 - o.width, Math.max(0, o.x + dx));
        next.y = Math.min(100 - o.height, Math.max(0, o.y + dy));
      } else {
        const left = o.x + (drag.mode.includes("w") ? dx : 0);
        const right = o.x + o.width + (drag.mode.includes("e") ? dx : 0);
        const top = o.y + (drag.mode.includes("n") ? dy : 0);
        const bottom = o.y + o.height + (drag.mode.includes("s") ? dy : 0);
        next = {
          x: Math.max(0, Math.min(left, right - min)),
          y: Math.max(0, Math.min(top, bottom - min)),
          width: Math.max(min, Math.min(100 - Math.max(0, left), right - Math.max(0, left))),
          height: Math.max(min, Math.min(100 - Math.max(0, top), bottom - Math.max(0, top))),
        };
      }
      setDraftCrop(percentToCrop(next, natural));
    },
    [natural],
  );

  useEffect(() => {
    if (!cropping) return;
    const move = (e: PointerEvent) => applyDrag(e.clientX, e.clientY);
    const up = () => {
      dragRef.current = null;
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
  }, [applyDrag, cropping]);

  const startDrag = (mode: DragState["mode"]) => (e: React.PointerEvent) => {
    e.stopPropagation();
    e.preventDefault();
    dragRef.current = {
      mode,
      startX: e.clientX,
      startY: e.clientY,
      origin: cropPercent,
    };
  };

  const confirmCrop = () => {
    if (!draftCrop || !natural) return;
    beginEdit(id);
    setData(id, { crop: clampCrop(draftCrop, natural) });
    setCropping(false);
  };

  const resetCrop = () => {
    if (!natural) return;
    beginEdit(id);
    setData(id, { crop: { x: 0, y: 0, width: natural.width, height: natural.height } });
  };

  return (
    <NodeView
      title={data.title}
      icon={<ImagePlus size={12} />}
      tag={data.src ? (cropped ? "已裁剪" : data.generatedBy ? "AI 生成" : "原图") : "空"}
      selected={selected}
      className="nv-image"
      headActions={
        <>
          {data.src ? (
            <button className="nv-btn" onClick={() => setCropping((v) => !v)} title="裁剪">
              <Crop size={11} />
            </button>
          ) : null}
          {cropped ? (
            <button className="nv-btn" onClick={resetCrop} title="复原为原图">
              <RotateCcw size={11} />
            </button>
          ) : null}
          {/* 图片动作（对标 aiCreation_canvas_imageAction_*）：抠图 / 增强 / 扩图 / 编辑 */}
          {data.src ? (
            <button
              className={`nv-btn${actionOpen ? " is-on" : ""}`}
              data-testid={`image-actions-${id}`}
              onClick={() => setActionOpen((v) => !v)}
              title="图片动作：抠图 / 增强 / 扩图 / 编辑（会改掉这一张，可 Ctrl+Z 撤回）"
            >
              <Wand2 size={11} /> 改图
            </button>
          ) : null}
          <button className="nv-btn" onClick={pick} title="选择本地图片">
            换图
          </button>
        </>
      }
    >
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        className="hidden-input"
        onChange={(e) => {
          void onFile(e.target.files?.[0]);
          e.target.value = "";
        }}
      />

      {/* 图片动作菜单：抠图 / 增强 / 扩图 / 编辑 */}
      {actionOpen && data.src ? (
        <div className="image-actions nodrag" data-testid={`image-actions-menu-${id}`}>
          {/*
           * 只列"不需要用户输入"的动作。自由编辑有自己的输入框 + 「改」按钮，
           * 如果它也在这里列一个按钮，界面上就会出现两个语义相同的入口
           * （而且它们会撞同一个 data-testid，验收脚本都选不准）。
           */}
          {IMAGE_ACTIONS.filter((a) => !a.needsInstruction).map((action) => (
            <button
              key={action.id}
              className="image-action"
              data-image-action={action.id}
              data-testid={`image-action-${action.id}-${id}`}
              disabled={Boolean(running)}
              title={action.hint}
              onClick={() => void runAction(action.id)}
            >
              {running === action.id ? "改图中…" : action.label}
            </button>
          ))}

          <div className="image-action-edit">
            <input
              className="image-action-input"
              data-testid={`image-instruction-${id}`}
              placeholder="或写一句：把天空换成星空"
              value={instruction}
              onChange={(e) => setInstruction(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void runAction("edit");
              }}
            />
            <button
              className="image-action is-go"
              data-image-action="edit"
              data-testid={`image-action-edit-go-${id}`}
              disabled={Boolean(running) || !instruction.trim()}
              onClick={() => void runAction("edit")}
            >
              {running === "edit" ? "改图中…" : "改"}
            </button>
          </div>

          <div className="image-action-note">会改掉这一张图；不满意按 Ctrl+Z 撤回</div>
        </div>
      ) : null}

      {running ? (
        <div className="image-action-busy" data-testid={`image-action-busy-${id}`}>
          正在改图（约 30 秒）…
        </div>
      ) : null}

      {error ? (
        <div className="image-action-error" data-testid={`image-error-${id}`}>
          {error}
        </div>
      ) : null}

      {data.src ? (
        cropping ? (
          /*
           * 裁剪态：舞台（图片 + 选择框）与操作条是**并列的 flex 子项**，
           * 操作条不能压在舞台之上 —— 选择框铺满时会盖住按钮，导致点不到「应用」。
           */
          <div className="nv-crop-wrap">
            <div className="nv-crop" ref={stageRef}>
              <img className="nv-crop-img" src={data.src} alt={data.alt} draggable={false} />
              <div
                className="nv-crop-box nodrag"
                style={{
                  left: `${cropPercent.x}%`,
                  top: `${cropPercent.y}%`,
                  width: `${cropPercent.width}%`,
                  height: `${cropPercent.height}%`,
                }}
                onPointerDown={startDrag("move")}
              >
                <span className="nv-crop-h nw" onPointerDown={startDrag("nw")} />
                <span className="nv-crop-h ne" onPointerDown={startDrag("ne")} />
                <span className="nv-crop-h sw" onPointerDown={startDrag("sw")} />
                <span className="nv-crop-h se" onPointerDown={startDrag("se")} />
              </div>
            </div>
            <div className="nv-crop-bar nodrag">
              <span className="nv-crop-size">
                {draftCrop ? `${draftCrop.width}×${draftCrop.height}` : ""}
              </span>
              <button className="nv-btn" onClick={confirmCrop} title="应用裁剪">
                <Check size={11} /> 应用
              </button>
              <button
                className="nv-btn"
                onClick={() => {
                  setCropping(false);
                  setDraftCrop(data.crop ?? null);
                }}
                title="取消"
              >
                <X size={11} />
              </button>
            </div>
          </div>
        ) : (
          <div className="nv-image-frame">
            <img
              className="nv-image-img"
              src={data.src}
              alt={data.alt}
              draggable={false}
              style={cropStyle(data.crop, natural)}
              onError={() => setError("图片加载失败")}
              /**
               * 图一加载出来就把原图尺寸补上（只补一次，已经有值就不动）。
               *
               * 为什么放在这里而不是各条写入路径上：`natural` 原来只在**本地上传**时设置，
               * 于是 AI 生成/改图出来的节点一直没有它 —— 后果是
               * 「扩图」不知道该扩到多大（只能沿用输入尺寸，等于没扩）、
               * 节点不显示尺寸、裁剪功能也降级。
               * 放在渲染器里测一次，上传 / 生成 / 改图 / 从磁盘恢复**四条路径一起覆盖**，
               * 以后再加新的写图路径也不用记着补。
               */
              onLoad={(e) => {
                if (natural) return;
                const el = e.currentTarget;
                if (!el.naturalWidth || !el.naturalHeight) return;
                setData(id, {
                  natural: { width: el.naturalWidth, height: el.naturalHeight },
                });
              }}
            />
          </div>
        )
      ) : (
        <button className="nv-drop nodrag" onClick={pick}>
          <ImagePlus size={18} />
          <span>{busy ? "读取中…" : data.alt || "点击上传图片"}</span>
        </button>
      )}

      {natural && data.src && !cropping ? (
        <div className="nv-image-meta">
          {natural.width}×{natural.height}
          {data.crop && !isFullCrop(data.crop, natural)
            ? ` · 裁剪 ${data.crop.width}×${data.crop.height}`
            : ""}
        </div>
      ) : null}
      {error ? <div className="nv-warn">{error}</div> : null}
      <NodeGenerationBar node={{ id, type: "image", data }} />
    </NodeView>
  );
}
