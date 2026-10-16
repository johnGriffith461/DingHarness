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

/**
 * 只初始化一次 Mermaid（securityLevel: strict = 不允许执行图表里的脚本）。
 *
 * ⚠️ 2026-10-16（审计 **P253**）：失败的那次**不许被永久缓存**。
 * 原来 `mermaidReady` 一旦赋值就不再动，`import("mermaid")` / `initialize` 抛错之后
 * 仍然留着一个 rejected Promise —— 于是**此后每个图表节点**的 catch 分支都拿到同一条
 * rejection（界面显示成「语法错误」），直到重启应用才自愈。
 * 触发条件在打包产物里很现实：懒分块读取失败（离线首开、更新后旧 chunk 被删而进程还活着、
 * 杀软占着文件）。用户看到的是"我改语法也没用"，而提示把**加载失败**伪装成了**语法错误**。
 *
 * 现在：失败就把缓存清掉再抛 —— 下一个节点还会再试一次（自愈），
 * 并且调用方能从错误里分辨这是加载失败而不是语法问题（见下面的 `MermaidLoadError`）。
 */
export class MermaidLoadError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message.split("\n")[0] ?? "Mermaid 加载失败" : "Mermaid 加载失败");
    this.name = "MermaidLoadError";
  }
}

function loadMermaid(): Promise<MermaidApi> {
  if (!mermaidReady) {
    mermaidReady = import("mermaid")
      .then((mod) => {
        const mermaid = mod.default;
        mermaid.initialize({ startOnLoad: false, securityLevel: "strict", ...MERMAID_CONFIG });
        return mermaid as unknown as MermaidApi;
      })
      .catch((error: unknown) => {
        /* 别把这个 rejection 留成"永久结论"：清掉，让下一个节点再试一次 */
        mermaidReady = null;
        throw new MermaidLoadError(error);
      });
  }
  return mermaidReady;
}

/** 每次渲染要一个唯一 id，否则 Mermaid 会因为重复 id 报错。 */
let renderSeq = 0;

/**
 * 输入停多久才真去渲染（2026-10-16，审计 **P250**）。
 *
 * ⚠️ 渲染 effect 原来**直接吃输入态** `draft`：每敲一个字符就起一次
 * **完整的** `mermaid.render`（全量 parse + 建 SVG；Mermaid 解析在主线程，没法 worker 化），
 * 而 cleanup 只置 `cancelled = true` —— **已经排队的渲染不会被取消**，仍会跑完再丢弃结果。
 * 于是打 60 个字 = 60 次完整渲染排队，实测就是"边打字边卡、掉帧"。
 *
 * 现在把"输入"与"要渲染的内容"分开：输入立刻进 state（受控不受影响），
 * 渲染等这么久静默之后才开始。250ms 是打字节奏里常见的间隔。
 */
const RENDER_DEBOUNCE_MS = 250;

export default function MermaidNodeView({ id, data, selected }: NodeProps<MermaidNodeType>) {
  const { beginEdit, setData } = useNodeActions();
  const [draft, setDraft] = useState(data.code);
  /** 真正拿去渲染的那份（滞后于输入 —— 见上面 RENDER_DEBOUNCE_MS 的说明）。 */
  const [rendered, setRendered] = useState(data.code);
  const [svg, setSvg] = useState("");
  const [error, setError] = useState<string | null>(null);
  /** 这次失败是"库没加载起来"（P253）而不是语法问题 —— 文案与标签都要分开说。 */
  const [loadFailed, setLoadFailed] = useState(false);
  const [busy, setBusy] = useState(true);

  useEffect(() => {
    setDraft(data.code);
  }, [data.code]);

  /* 节流：连续输入期间只有最后一个定时器能活到触发 */
  useEffect(() => {
    const timer = setTimeout(() => setRendered(draft), RENDER_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [draft]);

  useEffect(() => {
    let cancelled = false;
    setBusy(true);
    setError(null);
    setLoadFailed(false);

    void (async () => {
      try {
        const mermaid = await loadMermaid();
        const code = rendered.trim() || "flowchart LR\n  A[空] --> B[图表]";
        renderSeq += 1;
        const { svg: out } = await mermaid.render(`nv-mermaid-${id}-${renderSeq}`, code);
        if (cancelled) return;
        setSvg(out);
        setBusy(false);
      } catch (e) {
        if (cancelled) return;
        /*
         * ⚠️ 两种失败要说清是哪一种（审计 P253）：库没加载起来与"语法有误"是两回事 ——
         * 混成「语法错误」会让用户一直去改语法（他改到对也没用）。
         */
        setLoadFailed(e instanceof MermaidLoadError);
        setError(
          e instanceof MermaidLoadError
            ? "图表库没加载起来（可能是更新后旧分块读不到）—— 重开这个节点会再试一次"
            : e instanceof Error
              ? e.message.split("\n")[0]
              : "图表语法有误",
        );
        setBusy(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [rendered, id]);

  return (
    <NodeView
      title={data.title}
      icon={<Radio size={12} />}
      tag={error ? (loadFailed ? "图表库未加载" : "语法错误") : "mermaid"}
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
