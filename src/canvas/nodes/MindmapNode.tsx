import { useEffect, useRef, useState } from "react";
import { Network } from "lucide-react";
import type { NodeProps } from "@xyflow/react";
import type { MindmapNode as MindmapNodeType } from "../types";
import { NodeView } from "./NodeView";
import NodeGenerationBar from "./NodeGenerationBar";
import { useNodeActions } from "../useNodeActions";

/**
 * 思维导图节点（PLAN 2.7）：Markdown 大纲 → markmap 可折叠图。
 *
 * `markmap-lib`（Markdown→树）与 `markmap-view`（画）都是重量级依赖，
 * 所以放进**动态 import + 懒加载**里，不拖累首屏。
 * 大纲语法有问题时不炸节点，原地提示，并且保留上一次画出来的图。
 */
export default function MindmapNodeView({ id, data, selected }: NodeProps<MindmapNodeType>) {
  const { beginEdit, setData } = useNodeActions();
  const [draft, setDraft] = useState(data.markdown);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const mmRef = useRef<{ fit: () => void; setData?: (d: unknown) => void } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(true);

  useEffect(() => {
    setDraft(data.markdown);
  }, [data.markdown]);

  useEffect(() => {
    let cancelled = false;
    setBusy(true);
    setError(null);

    void (async () => {
      try {
        const [{ Transformer }, { Markmap }] = await Promise.all([
          import("markmap-lib"),
          import("markmap-view"),
        ]);
        if (cancelled) return;
        const svg = svgRef.current;
        if (!svg) return;

        const transformer = new Transformer();
        const { root } = transformer.transform(draft);

        if (!mmRef.current) {
          const mm = Markmap.create(svg, {
            autoFit: true,
            duration: 200,
            spacingVertical: 6,
            // 卡片宽度有限，节点文本必须换行，否则会被卡片裁掉
            maxWidth: 260,
          });
          mmRef.current = mm as unknown as { fit: () => void; setData?: (d: unknown) => void };
        }
        mmRef.current.setData?.(root);
        // 首次挂载时容器尺寸还在收敛，多试两帧再 fit，避免图上移/缩到看不见
        requestAnimationFrame(() => {
          mmRef.current?.fit();
          requestAnimationFrame(() => mmRef.current?.fit());
        });
        if (!cancelled) setBusy(false);
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : "导图渲染失败");
          setBusy(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [draft]);

  useEffect(() => {
    const host = svgRef.current?.parentElement;
    if (!host || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => mmRef.current?.fit());
    ro.observe(host);
    return () => ro.disconnect();
  }, []);

  useEffect(
    () => () => {
      mmRef.current = null;
    },
    [],
  );

  return (
    <NodeView
      title={data.title}
      icon={<Network size={12} />}
      tag="markmap"
      selected={selected}
      className="nv-mindmap"
      fixedSize
      headActions={
        <button
          className="nv-btn"
          title="重新适配视图"
          onClick={() => requestAnimationFrame(() => mmRef.current?.fit())}
        >
          适配
        </button>
      }
    >
      <div className="nv-split">
        <div className="nv-split-main">
          {/*
            这里**不能**套 DeferredRender：它就地把宿主 div 延后挂载，
            而渲染 effect 是在挂载后立刻跑的，那时 ref 还是 null，
            于是第一次渲染永远拿不到 svg、节点会一直停在"渲染中"。
            React Flow 的 onlyRenderVisibleElements 已经保证了视口外的节点不渲染。
          */}
          <div className="nv-graph-host">
            <svg ref={svgRef} className="nv-graph-svg" />
            {busy ? <div className="nv-graph-loading">导图渲染中…</div> : null}
          </div>
        </div>
        <textarea
          className="nv-input nv-split-side nodrag nowheel"
          value={draft}
          spellCheck={false}
          placeholder={"# 中心主题\n## 分支\n- 要点"}
          onChange={(e) => {
            setDraft(e.target.value);
            beginEdit(id);
            setData(id, { markdown: e.target.value });
          }}
        />
      </div>
      {error ? <div className="nv-warn">{error}</div> : null}
      <NodeGenerationBar node={{ id, type: "mindmap", data }} />
    </NodeView>
  );
}
