import { useEffect, useMemo, useState } from "react";
import { Eye, Pencil, Type } from "lucide-react";
import type { NodeProps } from "@xyflow/react";
import type { MarkdownNode as MarkdownNodeType } from "../types";
import { NodeView } from "./NodeView";
import NodeGenerationBar from "./NodeGenerationBar";
import NodeWritingBar from "./NodeWritingBar";
import DeferredRender from "./DeferredRender";
import { useNodeActions } from "../useNodeActions";
import { renderMarkdown } from "@/utils/markdown";
import { textStyleToCss } from "../textStyle";

/**
 * 文本 / Markdown 节点（PLAN 2.1）。
 *
 * 两态：编辑态是纯文本输入框；预览态渲染 Markdown，并过 pangu 中英混排
 * （对标原版 —— 它在文本节点上就是这么做的，见 HANDOFF §6.5）。
 * 渲染结果按视口懒加载，长文档不会在拖动画布时反复重排。
 */
export default function MarkdownNodeView({ id, data, selected }: NodeProps<MarkdownNodeType>) {
  const { beginEdit, setData } = useNodeActions();
  const [draft, setDraft] = useState(data.text);

  // 外部改动（撤销、AI 生成）要覆盖本地草稿
  useEffect(() => {
    setDraft(data.text);
  }, [data.text]);

  const html = useMemo(() => (data.preview ? renderMarkdown(draft) : ""), [draft, data.preview]);

  return (
    <NodeView
      title={data.title}
      icon={<Type size={12} />}
      tag={data.preview ? "预览" : "编辑"}
      selected={selected}
      className="nv-markdown"
      headActions={
        <>
          <NodeWritingBar nodeId={id} />
          <button
            className="nv-btn"
            onClick={() => setData(id, { preview: !data.preview })}
            title={data.preview ? "切到编辑态" : "切到预览态"}
          >
            {data.preview ? <Pencil size={11} /> : <Eye size={11} />}
            {data.preview ? "编辑" : "预览"}
          </button>
        </>
      }
    >
      {data.preview ? (
        <DeferredRender resetKey={draft}>
          <div
            className="nv-markdown-body"
            // 文字排版（阶段 8.5）：字距/行高/字号/字重/对齐/边框/自动宽高都落在这里
            style={textStyleToCss(data.textStyle)}
            // 内容由 renderMarkdown 构造并消毒（文本先转义、标签走白名单）
            dangerouslySetInnerHTML={{ __html: html }}
          />
        </DeferredRender>
      ) : (
        <textarea
          className="nv-input nodrag nowheel"
          style={textStyleToCss(data.textStyle)}
          value={draft}
          rows={8}
          spellCheck={false}
          placeholder="支持 Markdown：# 标题、**粗体**、- 列表、```代码块```"
          onChange={(e) => {
            setDraft(e.target.value);
            beginEdit(id);
            setData(id, { text: e.target.value });
          }}
        />
      )}
      <NodeGenerationBar node={{ id, type: "markdown", data }} />
    </NodeView>
  );
}
