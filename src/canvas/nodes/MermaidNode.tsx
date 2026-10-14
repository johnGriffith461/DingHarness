import { useEffect, useState } from "react";
import { Radio } from "lucide-react";
import type { NodeProps } from "@xyflow/react";
import type { MermaidNode as MermaidNodeType } from "../types";
import { NodeView } from "./NodeView";
import NodeGenerationBar from "./NodeGenerationBar";
import { useNodeActions } from "../useNodeActions";

/**
 * 图表节点（PLAN 2.8）：Mermaid 源码 → SVG。
 *
 * Mermaid 全局只能 initialize 一次（重复初始化会产生冲突的图表 id 与主题），
 * 所以这里缓存一个初始化的 Promise，所有节点共用。
 * 渲染失败（写到一半的语法）时保留上一次成功的图，只在下方提示错误，
 * 边改边看不会因为中间态把整块内容清空。
 *
 * 同样有 `vendors-mermaid.js` 的原版（PLAN §1）用的是同一个库，这里动态 import。
 */

/*
 * ⚠️ Mermaid 要的是**字面量字体串**（它把这段塞进 SVG 的 style），拿不到 CSS 变量 ——
 * 所以这里是 `--dh-font-text`（Ding Harness 三族里的「阅读」族）的**唯一第二份拷贝**。
 * 改字体时两处一起改，别让它悄悄退回系统雅黑：图里的字与界面其它字不同族，
 * 一屏里就是两种字形（正是这轮要收掉的那种"半成品相"）。
 */
const MERMAID_FONT = '"MiSans VF", "MiSans", "Segoe UI", "Microsoft YaHei", system-ui, sans-serif';

const MERMAID_CONFIG = {
  theme: "dark",
  darkMode: true,
  fontFamily: MERMAID_FONT,
  themeVariables: {
    background: "#151922",
    primaryColor: "#1b2029",
    primaryTextColor: "#c9d1d9",
    primaryBorderColor: "#3b82f6",
    lineColor: "#4b5563",
    secondaryColor: "#1b2029",
    tertiaryColor: "#151922",
  },
} satisfies import("mermaid").MermaidConfig;

type MermaidApi = { render: (id: string, code: string) => Promise<{ svg: string }> };

let mermaidReady: Promise<MermaidApi> | null = null;

/** 只初始化一次 Mermaid（securityLevel: strict = 不允许执行图表里的脚本）。 */
function loadMermaid(): Promise<MermaidApi> {
  if (!mermaidReady) {
    mermaidReady = import("mermaid").then((mod) => {
      const mermaid = mod.default;
      mermaid.initialize({ startOnLoad: false, securityLevel: "strict", ...MERMAID_CONFIG });
      return mermaid as unknown as MermaidApi;
    });
  }
  return mermaidReady;
}

/** 每次渲染要一个唯一 id，否则 Mermaid 会因为重复 id 报错。 */
let renderSeq = 0;

export default function MermaidNodeView({ id, data, selected }: NodeProps<MermaidNodeType>) {
  const { beginEdit, setData } = useNodeActions();
  const [draft, setDraft] = useState(data.code);
  const [svg, setSvg] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(true);

  useEffect(() => {
    setDraft(data.code);
  }, [data.code]);

  useEffect(() => {
    let cancelled = false;
    setBusy(true);
    setError(null);

    void (async () => {
      try {
        const mermaid = await loadMermaid();
        const code = draft.trim() || "flowchart LR\n  A[空] --> B[图表]";
        renderSeq += 1;
        const { svg: out } = await mermaid.render(`nv-mermaid-${id}-${renderSeq}`, code);
        if (cancelled) return;
        setSvg(out);
        setBusy(false);
      } catch (e) {
        if (cancelled) return;
        setError(e instanceof Error ? e.message.split("\n")[0] : "图表语法有误");
        setBusy(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [draft, id]);

  return (
    <NodeView
      title={data.title}
      icon={<Radio size={12} />}
      tag={error ? "语法错误" : "mermaid"}
      selected={selected}
      className="nv-mermaid"
      fixedSize
    >
      <div className="nv-split nv-split-row">
        <div className="nv-split-main nv-graph-host">
          {/* 同 MindmapNode：不套 DeferredRender，它会把渲染需要的容器与渲染 effect 错开一帧 */}
          <div className="nv-mermaid-svg" dangerouslySetInnerHTML={{ __html: svg }} />
          {busy ? <div className="nv-graph-loading">图表渲染中…</div> : null}
        </div>
        <textarea
          className="nv-input nv-split-side nodrag nowheel"
          value={draft}
          rows={5}
          spellCheck={false}
          placeholder={"flowchart LR\n  A[开始] --> B[结束]"}
          onChange={(e) => {
            setDraft(e.target.value);
            beginEdit(id);
            setData(id, { code: e.target.value });
          }}
        />
      </div>
      {error ? <div className="nv-warn">{error}</div> : null}
      <NodeGenerationBar node={{ id, type: "mermaid", data }} />
    </NodeView>
  );
}
