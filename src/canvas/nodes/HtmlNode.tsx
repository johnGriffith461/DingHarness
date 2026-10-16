import { useMemo, useRef, useState, useEffect } from "react";
import { AlertTriangle, Code2, Eye, Globe, GlobeLock, Pencil } from "lucide-react";
import type { NodeProps } from "@xyflow/react";
import type { HtmlNode as HtmlNodeType } from "../types";
import { NodeView } from "./NodeView";
import DeferredRender from "./DeferredRender";
import { useNodeActions } from "../useNodeActions";
import { createEditBuffer } from "../textCommit";
import {
  buildSrcdoc,
  describeHtml,
  makeChannelId,
  MAX_FRAME_HEIGHT,
  MIN_FRAME_HEIGHT,
  parseFrameMessage,
} from "../htmlFrame";

/**
 * HTML 节点（阶段 9.1，对标原版 `data-canvas-html-*`）。
 *
 * 预览走**沙箱 iframe**，只给 `allow-scripts`、**不给 `allow-same-origin`** ——
 * 原版两个一起给是沙箱自毁（见 `htmlFrame.ts`）。代价是宿主读不到 iframe 内部，
 * 所以高度由 iframe 主动 postMessage 上报，宿主校验来源后采用。
 *
 * 界面上那句"这段 HTML 会执行 N 段脚本 / 引用 M 个外链"是有意做的：
 * 粘贴一段不知道哪来的 HTML 时，**告诉用户它会做什么**比任何免责声明都有用。
 */
export default function HtmlNodeView({ id, data, selected }: NodeProps<HtmlNodeType>) {
  const { beginEdit, setData } = useNodeActions();
  const [draft, setDraft] = useState(data.html);
  const [frameHeight, setFrameHeight] = useState(240);
  const [frameError, setFrameError] = useState<string | null>(null);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  /** 编辑态**只由 `data.preview` 决定**，不另外存一份 state —— 两份状态必然对不上。 */
  const editing = !data.preview;
  /**
   * 编辑缓冲（2026-10-16 审计 P27）：源码原来只在 blur 时提交，
   * 而画布开着 `onlyRenderVisibleElements` —— 滚出视野、或主人把画布面板一关，
   * 「编辑中」的节点就**卸载**了，blur 永远不来，这段源码只存在于组件内部。
   * 现在 blur 与**卸载**走同一份口径（`textCommit.ts`，`flush` 幂等）。
   */
  const bufferRef = useRef<ReturnType<typeof createEditBuffer> | null>(null);
  if (bufferRef.current === null) {
    bufferRef.current = createEditBuffer((value) => {
      beginEdit(id);
      setData(id, { html: value });
    });
  }
  const buffer = bufferRef.current;

  useEffect(() => {
    setDraft(data.html);
    buffer.reset(data.html);
  }, [data.html, buffer]);

  useEffect(
    () => () => {
      /* ⚠️ 卸载前把没提交的源码交出去（P27）；没有未提交的值时它什么都不做 */
      buffer.flush();
    },
    [buffer],
  );

  /**
   * channelId 必须**跟着内容换**：内容变了要重建 iframe（否则旧文档还跑着），
   * 换 id 能顺带把上一版 iframe 迟到的上报挡掉。
   */
  const channelId = useMemo(() => makeChannelId(), [data.html, data.allowNetwork]);
  const srcdoc = useMemo(
    () => buildSrcdoc(data.html, channelId, Boolean(data.allowNetwork)),
    [data.html, channelId, data.allowNetwork],
  );

  /** 收 iframe 的上报：校验来源（channelId + event.source 双保险）后才采用。 */
  useEffect(() => {
    if (!data.preview) return;
    const onMessage = (event: MessageEvent) => {
      const fromOurFrame = event.source === iframeRef.current?.contentWindow;
      const msg = parseFrameMessage(event.data, channelId, fromOurFrame);
      if (!msg) return;
      if (msg.kind === "height") {
        setFrameHeight(Math.max(MIN_FRAME_HEIGHT, Math.min(MAX_FRAME_HEIGHT, msg.height)));
      } else {
        setFrameError(msg.message);
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [channelId, data.preview]);

  const stats = useMemo(() => describeHtml(data.html), [data.html]);

  /**
   * 预览/编辑切换。
   *
   * 这里**必须分两个明确分支**：先前写成"先调 commit()（它自己会写 preview:true）
   * 再写 preview:!data.preview"，结果第二次写把第一次的 `true` 又翻回 `false`，
   * 点「预览」看着毫无反应。
   *
   * ⚠️ 切到预览时必须**先把草稿落盘**（P27）：源码输入框会随这一下被卸载，
   * 而预览渲染的是 `data.html` —— 不 flush 的话用户看到的是**旧内容**
   *（"我改完点预览，怎么还是原来那段"），而缓冲里那份最终还会在别处被写回去。
   */
  const togglePreview = () => {
    if (editing) {
      buffer.flush();
      setData(id, { preview: true });
      setFrameError(null);
      return;
    }
    // 预览 → 编辑：只切状态，别动内容
    setData(id, { preview: false });
  };

  return (
    <NodeView
      title={data.title}
      icon={<Code2 size={12} />}
      tag={data.preview ? (data.allowNetwork ? "联网" : "断网") : "源码"}
      selected={selected}
      className="nv-html"
      headActions={
        <>
          <button
            className="nv-btn"
            data-testid={`html-toggle-${id}`}
            title={data.preview ? "编辑源码" : "看渲染结果"}
            onClick={togglePreview}
          >
            {data.preview ? <Pencil size={11} /> : <Eye size={11} />}
            {data.preview ? "编辑" : "预览"}
          </button>
          <button
            className="nv-btn"
            data-testid={`html-network-${id}`}
            title={
              data.allowNetwork
                ? "当前允许 https 外链（脚本/样式/请求）。点一下改为断网"
                : "当前断网：外链脚本不执行、请求发不出去。点一下放行 https 外链"
            }
            onClick={() => {
              beginEdit(id);
              setData(id, { allowNetwork: !data.allowNetwork });
              setFrameError(null);
            }}
          >
            {data.allowNetwork ? <Globe size={11} /> : <GlobeLock size={11} />}
            {data.allowNetwork ? "联网" : "断网"}
          </button>
        </>
      }
    >
      {/* 沙箱说明：让用户知道自己粘贴的东西会被怎么对待 */}
      <div className="nv-html-note" data-canvas-html-editor>
        {stats.scripts > 0 || stats.externalRefs > 0 ? (
          <>
            <AlertTriangle size={10} />
            这段 HTML 会执行 <b>{stats.scripts}</b> 段脚本
            {stats.externalRefs > 0 ? (
              <>
                ，引用 <b>{stats.externalRefs}</b> 个外链
                {data.allowNetwork ? "（已放行）" : "（已拦截）"}
              </>
            ) : null}
          </>
        ) : (
          <>纯静态内容，无脚本、无外链</>
        )}
      </div>

      {data.preview ? (
        <DeferredRender resetKey={`${data.html.length}-${String(data.allowNetwork)}`}>
          <div className="nv-html-stage" data-canvas-html-surface>
            <iframe
              ref={iframeRef}
              // 只给 allow-scripts：不给 allow-same-origin，被框内容拿不到宿主
              sandbox="allow-scripts"
              srcDoc={srcdoc}
              title={data.title}
              className="nv-html-frame"
              style={{ height: frameHeight }}
              data-html-mount-id={id}
              data-html-status={frameError ? "error" : "ready"}
            />
          </div>
        </DeferredRender>
      ) : (
        <textarea
          className="nv-input nodrag nowheel"
          data-testid={`html-source-${id}`}
          value={draft}
          rows={12}
          spellCheck={false}
          placeholder="粘贴或写一段 HTML，支持 <style>/<script>（在沙箱里跑）"
          onChange={(e) => {
            setDraft(e.target.value);
            buffer.set(e.target.value);
            beginEdit(id);
          }}
          onBlur={() => {
            buffer.flush();
          }}
        />
      )}

      {frameError ? (
        <div className="nv-html-error" data-canvas-html-save-error>
          页面里报错：{frameError}
        </div>
      ) : null}
    </NodeView>
  );
}
