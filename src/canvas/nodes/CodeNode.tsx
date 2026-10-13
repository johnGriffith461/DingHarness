import { useEffect, useMemo, useRef, useState } from "react";
import { Code2, Eye, Pencil } from "lucide-react";
import type { NodeProps } from "@xyflow/react";
import Prism from "prismjs";
// 按需引入语言包：Prism 核心自带 markup / css / clike / javascript
import "prismjs/components/prism-typescript";
import "prismjs/components/prism-jsx";
import "prismjs/components/prism-tsx";
import "prismjs/components/prism-json";
import "prismjs/components/prism-bash";
import "prismjs/components/prism-python";
import "prismjs/components/prism-sql";
import "prismjs/components/prism-yaml";
import "prismjs/components/prism-markdown";
import type { CodeNode as CodeNodeType } from "../types";
import { NodeView } from "./NodeView";
import NodeGenerationBar from "./NodeGenerationBar";
import DeferredRender from "./DeferredRender";
import { useNodeActions } from "../useNodeActions";

/**
 * 代码节点（PLAN 2.2）。
 *
 * 高亮用 Prism（原版库清单里同时有 Prism 与 highlight.js，见 PLAN §1）。
 * 行号自己画、与代码区滚动联动。大代码块走懒渲染（HANDOFF §6.3）：
 * 拖动画布时不会因为反复 tokenize 掉帧，超长文件也只高亮前若干行。
 */

const LANGS = [
  "ts",
  "tsx",
  "js",
  "jsx",
  "json",
  "python",
  "bash",
  "sql",
  "yaml",
  "markdown",
  "css",
  "text",
] as const;

/** 界面语言标识 → Prism 语法名。 */
const PRISM_LANG: Record<string, string> = {
  ts: "typescript",
  tsx: "tsx",
  js: "javascript",
  jsx: "jsx",
  json: "json",
  python: "python",
  bash: "bash",
  sql: "sql",
  yaml: "yaml",
  markdown: "markdown",
  css: "css",
};

/** 超过这个行数只高亮前 N 行，避免单个节点吃掉整个画布性能。 */
const MAX_HIGHLIGHT_LINES = 600;

export default function CodeNodeView({ id, data, selected }: NodeProps<CodeNodeType>) {
  const { beginEdit, setData } = useNodeActions();
  const [draft, setDraft] = useState(data.code);
  const gutterRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    setDraft(data.code);
  }, [data.code]);

  const lines = useMemo(() => draft.split("\n"), [draft]);
  const shown = useMemo(() => lines.slice(0, MAX_HIGHLIGHT_LINES), [lines]);
  const truncated = lines.length > MAX_HIGHLIGHT_LINES;

  const highlighted = useMemo(() => {
    const prismName = PRISM_LANG[data.lang];
    const grammar = prismName ? Prism.languages[prismName] : undefined;
    if (!grammar || !prismName) return null;
    try {
      return Prism.highlight(shown.join("\n"), grammar, prismName);
    } catch {
      return null;
    }
  }, [shown, data.lang]);

  /** 编辑态与预览态的滚动要联动，否则行号和代码会错位。 */
  const syncScroll = (from: HTMLElement, to: HTMLElement | null) => {
    if (!to) return;
    const max = Math.max(1, from.scrollHeight - from.clientHeight);
    to.scrollTop = (from.scrollTop / max) * Math.max(0, to.scrollHeight - to.clientHeight);
  };

  return (
    <NodeView
      title={data.title}
      icon={<Code2 size={12} />}
      selected={selected}
      className="nv-code"
      headActions={
        <>
          <select
            className="nv-select nodrag nowheel"
            value={data.lang}
            onChange={(e) => {
              beginEdit(id);
              setData(id, { lang: e.target.value });
            }}
          >
            {LANGS.map((lang) => (
              <option key={lang} value={lang}>
                {lang}
              </option>
            ))}
          </select>
          <button
            className="nv-btn"
            onClick={() => setData(id, { preview: !data.preview })}
            title={data.preview ? "切到编辑态" : "切到高亮预览"}
          >
            {data.preview ? <Pencil size={11} /> : <Eye size={11} />}
          </button>
        </>
      }
    >
      <div className="nv-codebox">
        <div className="nv-gutter" ref={gutterRef} aria-hidden>
          {shown.map((_, i) => (
            <span key={i}>{i + 1}</span>
          ))}
          {truncated ? <span className="nv-gutter-more">…</span> : null}
        </div>

        {data.preview ? (
          <DeferredRender resetKey={draft}>
            <pre className="nv-code-pre" onScroll={(e) => syncScroll(e.currentTarget, gutterRef.current)}>
              {highlighted ? (
                <code
                  className={`language-${PRISM_LANG[data.lang] ?? "text"}`}
                  dangerouslySetInnerHTML={{ __html: highlighted }}
                />
              ) : (
                <code>{shown.join("\n")}</code>
              )}
              {truncated ? (
                <span className="nv-code-more">{`\n… 已省略后 ${lines.length - MAX_HIGHLIGHT_LINES} 行`}</span>
              ) : null}
            </pre>
          </DeferredRender>
        ) : (
          <textarea
            className="nv-input nv-code-input nodrag nowheel"
            value={draft}
            rows={Math.min(Math.max(lines.length, 5), 22)}
            spellCheck={false}
            onChange={(e) => {
              setDraft(e.target.value);
              beginEdit(id);
              setData(id, { code: e.target.value });
            }}
            onScroll={(e) => syncScroll(e.currentTarget, gutterRef.current)}
          />
        )}
      </div>
      <NodeGenerationBar node={{ id, type: "code", data }} />
    </NodeView>
  );
}
