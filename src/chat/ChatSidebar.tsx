import { useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, AtSign, MessageSquarePlus, PanelLeftClose, RotateCcw, Send, Square } from "lucide-react";
import { useChatStore } from "@/ai/chatStore";
import { hasShellBridge } from "@/ai/aiClient";
import { useRuntimeStore } from "@/canvas/runtimeStore";
import { ToolTraceList } from "@/workbench/ToolTraceList";
import { ArtifactCard } from "@/workbench/ArtifactCard";
import {
  nodeLabel,
  parseReferences,
  referenceCandidates,
  referencesToPrompt,
} from "@/canvas/references";

/**
 * 侧栏对话（PLAN 3.1，对标原版 `side_panel.html`）。
 *
 * 三块：会话切换 / 消息流（含流式光标与失败态）/ 输入区（含 provider 选择与中止）。
 * 流式内容直接来自 store，本组件不做缓冲 —— 缓冲统一放在 store 里做，
 * 避免"组件里也节流一份"导致两处行为不一致。
 */
export default function ChatSidebar({ onClose }: { onClose?: () => void } = {}) {
  const {
    conversations,
    activeId,
    messages,
    providers,
    provider,
    model,
    streamingId,
    probing,
    error,
    loadProviders,
    probeProviders,
    setModel,
    newConversation,
    selectConversation,
    send,
    abort,
    clearError,
  } = useChatStore();

  const [draft, setDraft] = useState("");
  /** 输入框里 "…@" 之后的部分（用于候选列表）；null 表示当前不在引用输入状态。 */
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const active = messages[activeId] ?? [];
  const shellReady = hasShellBridge();
  const currentProvider = providers.find((p) => p.id === provider);
  const busy = Boolean(streamingId);

  /**
   * 画布节点（做引用芯片用）。
   * 只订阅 id/type/data 这几样，节点拖动时不会让侧栏跟着重渲染。
   */
  const canvasNodes = useRuntimeStore((s) => s.nodes);

  /**
   * 曾经出现过的节点。
   * 引用芯片要能显示"这个节点已经被删了"，所以不能只看当前节点列表 ——
   * 否则用户会看到自己打的引用**无声消失**，还以为是自己没打对。
   */
  const knownNodesRef = useRef(canvasNodes);
  useEffect(() => {
    const merged = new Map(knownNodesRef.current.map((n) => [n.id, n]));
    for (const node of canvasNodes) merged.set(node.id, node);
    knownNodesRef.current = Array.from(merged.values());
  }, [canvasNodes]);

  const refs = useMemo(
    () => parseReferences(draft, canvasNodes, knownNodesRef.current),
    [draft, canvasNodes],
  );
  const candidates = useMemo(
    () => (mentionQuery === null ? [] : referenceCandidates(canvasNodes, mentionQuery)),
    [mentionQuery, canvasNodes],
  );

  /** 光标处插入一枚引用芯片。 */
  const insertReference = (label: string) => {
    setDraft((prev) => {
      if (mentionQuery === null) return `${prev}@${label} `;
      // 把正在输入的 "@xxx" 替换成完整引用
      const cut = prev.length - mentionQuery.length - 1;
      return `${prev.slice(0, Math.max(0, cut))}@${label} `;
    });
    setMentionQuery(null);
  };

  useEffect(() => {
    void loadProviders();
  }, [loadProviders]);

  /*
   * 从**会话日志**恢复历史（F3）。
   *
   * ⚠️ 放在挂载时而不是"应用启动时"：这一段日志是聊天侧唯一的持久化，
   * 谁挂载谁负责把它读回来（画布面板没打开时不读盘）。
   *
   * `restoreHistory` 自己会处理"还没有任何日志"（第一次跑）—— 那种情况什么都不做，
   * 保留初始那个空对话。
   */
  useEffect(() => {
    void useChatStore.getState().restoreHistory();
  }, []);

  // 新消息或流式增量都滚到底
  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [active.length, active[active.length - 1]?.content]);

  const submit = () => {
    const text = draft.trim();
    if (!text || busy) return;
    /**
     * 引用芯片在这里才展开成"给模型看的话"（阶段 5.4）：
     * 输入框里保持 `@标题` 这种可读可手打的写法，发出去才附上 id 与类型，
     * 这样气泡里仍然是用户写的原话，而模型知道每一枚芯片指向哪个节点。
     */
    /* 把**节点正文**一起带上（`referencesToPrompt` 第三个参数是每条的截断长度）——
     * 不带的话模型只能看见标题，而它没有读节点内容的工具。 */
    const refBlock = referencesToPrompt(parseReferences(text, canvasNodes, knownNodesRef.current), canvasNodes);
    setDraft("");
    setMentionQuery(null);
    void send(text, refBlock || undefined);
  };

  return (
    <aside className="side left">
      <div className="side-head">
        <span>对话</span>
        {/*
          收起的入口。原来**只有**那颗贴在侧栏右缘的 16px 小把手（`.wb-canvas-chat-toggle`，
          画着 `‹`）—— 既容易看漏，又像"往左导航"而不是"收起"。
          与右栏「对话摘要」用**同一颗带字的「收起」**（`SummaryPanel` 那边也是这么改的，
          主人 2026-10-14 的原话：「点一下面板按钮就打开了，然后怎么关呢？」）——
          两个右侧面板长一样，用户学一次就够。
        */}
        <button
          className="wb-summary-collapse"
          data-testid="wb-chat-collapse"
          aria-label="收起画布对话"
          title="收起画布对话"
          onClick={() => onClose?.()}
        >
          <PanelLeftClose size={13} /> 收起
        </button>
        <button className="side-icon" onClick={() => newConversation()} title="新会话">
          <MessageSquarePlus size={14} />
        </button>
      </div>

      {conversations.length > 1 ? (
        <div className="chat-tabs">
          {conversations.slice(0, 8).map((c) => (
            <button
              key={c.id}
              className={c.id === activeId ? "on" : ""}
              onClick={() => selectConversation(c.id)}
              title={c.title}
            >
              {c.title}
            </button>
          ))}
        </div>
      ) : null}

      <div className="chat-provider">
        {!shellReady ? (
          <span className="chat-warn" title="在 Electron 里启动才能用 AI">
            AI 通道不可用（需 Electron 壳）
          </span>
        ) : (
          <>
            <select
              value={provider}
              onChange={(e) => {
                const next = providers.find((p) => p.id === e.target.value);
                setModel(e.target.value, next?.models[0] ?? "");
              }}
              title="provider"
            >
              {providers.map((p) => (
                <option key={p.id} value={p.id} disabled={!p.available}>
                  {p.label}
                  {/* 「有密钥」和「真能调用」是两件事，标签上要分开说清 */}
                  {!p.available ? "（无密钥）" : p.verified ? "（已验证）" : "（未验证）"}
                </option>
              ))}
            </select>
            <button
              className="chat-probe"
              data-testid="probe-providers"
              disabled={probing}
              title="真发一次极短请求，验证哪些 provider 真的能调用"
              onClick={() => void probeProviders()}
            >
              {probing ? "探测中…" : "探测"}
            </button>
            <select
              value={model}
              onChange={(e) => setModel(provider, e.target.value)}
              title="模型"
            >
              {(currentProvider?.models ?? []).map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
            {currentProvider && currentProvider.available && !currentProvider.verified ? (
              <span className="chat-note" title={currentProvider.note}>
                还没验证过这家能不能真调用
              </span>
            ) : null}
          </>
        )}
      </div>

      <div className="chat-list" ref={listRef}>
        {active.length === 0 ? (
          <p className="muted">
            和 AI 一起在画布上干活：先在画布上选中素材，再在工具条点「AI 生成」，
            结果会落成新节点。也可以直接在这里提问。
          </p>
        ) : null}
        {active.map((m) => (
          <div key={m.id} className={`chat-msg ${m.role}${m.status === "error" ? " is-error" : ""}`}>
            <div className="chat-bubble">
              {m.content || (m.status === "streaming" ? "…" : "")}
              {/*
                ⚠️ 2026-10-14 挪进来的：光标原来挂在这个 `<div className="chat-msg">`（column flex）
                的**第一个子位置** —— 于是它**另起一行挂在气泡上方**，看起来像页面坏了。
                光标属于"正文的末尾"，所以放在正文之后、气泡里面。
              */}
              {m.role === "assistant" && m.status === "streaming" ? (
                <span className="chat-cursor" aria-hidden />
              ) : null}
              {m.status === "error" ? (
                <div className="chat-msg-error">
                  <AlertTriangle size={11} />
                  <span>{m.error ?? "生成失败"}</span>
                  {/*
                    失败必须**给出路**（§187 体检 P1）：原来只有一行红字，
                    用户唯一的办法是自己把话再打一遍。
                    ⚠️ 这颗按钮**接的是 store 里的 `retry`**（撤掉这条失败回复和
                    它对应的提问，用同一段话重走 `send`）—— 不是只把红字藏起来。
                  */}
                  <button
                    className="chat-retry"
                    data-testid={`chat-retry-${m.id}`}
                    title="用同一段话重发一次"
                    onClick={() => void useChatStore.getState().retry(activeId, m.id)}
                  >
                    <RotateCcw size={11} />
                    重试
                  </button>
                </div>
              ) : null}
            </div>
            {/*
              被闸门拦下的工具调用要**能就地处置**（§185）。
              原来是"只写了一行'等你确认'、却没有任何按钮" —— 
              那是一条无法处置的通知（§176 为子智能体修过同款）。
              ⚠️ 与工作台用**同一个组件**（`ToolTraceList`），只是 testid 前缀不同。
            */}
            {m.tools?.length ? (
              <ToolTraceList
                id={m.id}
                traces={m.tools}
                actionPrefix="chat-tool"
                onResolve={(toolCallId, approve) =>
                  void useChatStore.getState().resolveTool(activeId, m.id, toolCallId, approve)
                }
              />
            ) : null}
            {/*
              这条回复产出的文件（§186）：与工作台**同一个卡片组件**。
              不做的话，模型在聊天里写的产物标签会以原文留在正文里，
              而文件已经落盘 —— 界面上看不见，正是 §141 打的"暗箱"。
            */}
            {m.artifacts?.length ? (
              <div className="chat-artifacts" data-testid={`chat-artifacts-${m.id}`}>
                {m.artifacts.map((a) => (
                  <ArtifactCard key={a.id} artifact={a} />
                ))}
              </div>
            ) : null}
            {m.role === "assistant" && m.model ? (
              <div className="chat-meta">
                {m.model}
                {m.usage?.outputTokens ? ` · ${m.usage.outputTokens} tokens` : ""}
              </div>
            ) : null}
          </div>
        ))}
      </div>

      {error ? (
        <div className="chat-error" onClick={clearError} title="点击关闭">
          <AlertTriangle size={12} />
          {error}
        </div>
      ) : null}

      <div className="side-foot">
        {candidates.length > 0 ? (
          <div className="chat-mentions" data-testid="chat-mentions">
            <div className="chat-mentions-title">引用画布节点</div>
            {candidates.map((node) => (
              <button
                key={node.id}
                type="button"
                className="chat-mention-item"
                data-mention-node={node.id}
                onClick={() => insertReference(nodeLabel(node))}
              >
                <AtSign size={11} />
                <span className="chat-mention-label">{nodeLabel(node)}</span>
                <span className="chat-mention-kind">{node.type}</span>
              </button>
            ))}
          </div>
        ) : null}

        {refs.length > 0 ? (
          <div className="chat-refchips" data-testid="chat-refchips">
            {refs.map((ref) => (
              <span key={`${ref.start}-${ref.nodeId}`} className={`chat-refchip is-${ref.state}`}>
                <AtSign size={10} />
                {ref.label}
                <em>{ref.nodeId}</em>
              </span>
            ))}
          </div>
        ) : null}

        <div className="chat-compose">
          <textarea
            data-testid="chat-input"
            className="side-input"
            rows={2}
            placeholder={busy ? "生成中…" : "问点什么，或 @ 引用画布节点…"}
            value={draft}
            onChange={(e) => {
              const next = e.target.value;
              setDraft(next);
              // 光标前最后一个 "@xxx"（不含空白）就是当前正在输入的引用
              const tail = /@([^\s@]*)$/.exec(next);
              setMentionQuery(tail ? tail[1] : null);
            }}
            onKeyDown={(e) => {
              if (e.key === "Escape" && mentionQuery !== null) {
                e.preventDefault();
                setMentionQuery(null);
                return;
              }
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                // 候选列表开着时回车先选中第一项，避免误发
                if (candidates.length > 0) {
                  insertReference(nodeLabel(candidates[0]));
                  return;
                }
                submit();
              }
            }}
          />
          <button
            className="chat-ref-btn"
            data-testid="chat-ref-add"
            aria-label="引用画布节点" title="引用画布节点（也可以直接打 @）"
            onClick={() => {
              setDraft((prev) => `${prev}@`);
              setMentionQuery("");
            }}
          >
            <AtSign size={14} />
          </button>
          {busy ? (
            <button className="chat-send is-stop" data-testid="chat-send-stop" onClick={abort} aria-label="中止" title="中止">
              <Square size={14} />
            </button>
          ) : (
            <button className="chat-send" data-testid="chat-send" onClick={submit} disabled={!draft.trim()} aria-label="发送" title="发送（Enter）">
              <Send size={14} />
            </button>
          )}
        </div>
      </div>
    </aside>
  );
}
