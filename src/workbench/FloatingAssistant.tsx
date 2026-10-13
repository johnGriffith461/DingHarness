import { useCallback, useEffect, useRef, useState } from "react";
import { Minus, MoreHorizontal, Phone, Plus, Sparkles, Volume2 } from "lucide-react";
import { abortStream, streamChat } from "@/ai/aiClient";
import { applyEvent, emptyTurn, finishTurn } from "@shared/sessionLog";
import type { ShellBridge } from "@shared/ipc";
import { extractFilePaths, fileContextBlock } from "./fileContext";
import type { PathRead } from "./fileContextTypes";

/**
 * 悬浮助手窗（对标实机：任务顶栏第 3 个图标弹出的浮动面板）。
 *
 * ## 实机看到什么
 * 一个圆角浮动面板（约 400×600）压在应用之上，有**自己的标题栏**
 * （`—` / `⟳` / `▯` | 用户名 `›` | `📞` / `🔊` / `⊙` / `☰` / `▯`）、
 * 一块对话区、以及**一整套自己的输入区**
 * （「发消息或创建任务... / 使用技能 @ 添加资料」+ `＋` | 本地电脑 | `⋯` | 低 | 🎤）。
 *
 * 它是**快速问答**用的：不建任务、不进左侧列表，问一句答一句。
 * 这与主界面互补 —— 主界面是"开任务干活"，这里是"随手问一下"。
 *
 * ## 为什么要自己管一条对话
 * 走主任务流的话，每次随手问一句都会在左侧"最近"里多出一条任务，
 * 那正是悬浮窗想避免的。所以这里直接调 `streamChat`、自己存消息。
 */

type Bubble = { id: string; role: "user" | "assistant"; text: string };

/** 面板默认位置与尺寸（照实机量出来的比例）。 */
const DEFAULT_POS = { x: 610, y: 30 };
const SIZE = { width: 400, height: 600 };

export default function FloatingAssistant({ onClose, seed }: { onClose: () => void; seed?: string }) {
  const [pos, setPos] = useState(DEFAULT_POS);
  const [bubbles, setBubbles] = useState<Bubble[]>([]);
  const [text, setText] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [minimized, setMinimized] = useState(false);
  const dragRef = useRef<{ dx: number; dy: number } | null>(null);
  const requestRef = useRef<string | null>(null);
  const scroller = useRef<HTMLDivElement | null>(null);
  const seq = useRef(0);
  /** 预填的问题只发一次（否则每次重渲染都会再发一遍）。 */
  const seeded = useRef(false);

  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: "smooth" });
  }, [bubbles.length, bubbles.at(-1)?.text]);

  /**
   * 标题栏拖动。用 pointer 事件 + `setPointerCapture`，拖出面板范围也不会丢。
   *
   * ⚠️ **按下的是标题栏里的按钮时不能启动拖拽**：
   * `setPointerCapture` 会把后续 pointer 事件的 target 重定向到标题栏本身，
   * 于是按钮的 click 就再也收不到了 —— 表现为"拖过一次之后最小化/关闭都点不动"。
   * 这是实测踩出来的（验收里悬浮窗关不掉，一直挡着后面的元素）。
   */
  const onDragStart = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if ((event.target as HTMLElement).closest("button")) return;
      dragRef.current = { dx: event.clientX - pos.x, dy: event.clientY - pos.y };
      event.currentTarget.setPointerCapture(event.pointerId);
    },
    [pos.x, pos.y],
  );

  const onDragMove = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    /*
     * 夹在窗口内：不夹的话面板能被拖到屏幕外，用户再也找不回来 ——
     * 一个拖不回来的浮窗比不能拖更糟。至少留 80px 在窗口里。
     */
    const maxX = window.innerWidth - 80;
    const maxY = Math.max(0, window.innerHeight - 40);
    setPos({
      x: Math.min(Math.max(0, event.clientX - drag.dx), maxX),
      y: Math.min(Math.max(0, event.clientY - drag.dy), maxY),
    });
  }, []);

  const onDragEnd = useCallback(() => {
    dragRef.current = null;
  }, []);

  /** 带着预填问题打开：自动发一次（只发一次）。 */
  useEffect(() => {
    if (seeded.current || !seed) return;
    seeded.current = true;
    void send(seed);
    // send 每次渲染都是新引用，依赖它会导致重复触发；这里只关心 seed
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seed]);

  /** 读主界面保存的 provider/model（与任务通道同一套口径）。 */
  const route = (): { provider: string; model: string } => {
    try {
      const raw = localStorage.getItem("dsh-canvas.chat-settings");
      if (!raw) return { provider: "", model: "" };
      const parsed = JSON.parse(raw) as { provider?: string; model?: string };
      return { provider: parsed.provider ?? "", model: parsed.model ?? "" };
    } catch {
      return { provider: "", model: "" };
    }
  };

  const send = async (override?: string) => {
    const value = (override ?? text).trim();
    if (!value || streaming) return;
    setText("");
    const userId = `u${(seq.current += 1)}`;
    const replyId = `a${(seq.current += 1)}`;
    setBubbles((prev) => [...prev, { id: userId, role: "user", text: value }]);
    setStreaming(true);
    setBubbles((prev) => [...prev, { id: replyId, role: "assistant", text: "" }]);

    /*
     * 这一轮**也走投影**（C2）。悬浮助手原来是**第三份**解析（只处理 text/error）——
     * 它现在只拿 text/error 是"碰巧够用"，不是"设计如此"：主进程照样会发
     * tool-call / tool-result（这一条路没带工具，所以现在收不到，但那是**请求参数**决定的，
     * 不是这里决定的）。走投影之后，"以后它带了工具"不需要再改这一段。
     */
    let turn = emptyTurn();
    try {
      const { listProviders } = await import("@/ai/aiClient");
      let { provider, model } = route();
      if (!provider) {
        // 没存过设置就现场挑一个可用的（与任务通道同一套挑选顺序）
        const providers = await listProviders();
        const usable = providers.filter((p) => p.available);
        const pick = usable.find((p) => p.verified) ?? usable[0];
        if (pick) {
          provider = pick.id;
          model = pick.models[0] ?? "";
        }
      }
      /*
       * 「提到的文件」把内容带上（2026-10-14）。
       *
       * 云盘行菜单点「问问豆包」发下来的就是这样一句话：
       * `读一下这个文件：D:\...\季度总结.md 然后用一句话说清它讲了什么。`
       * —— 只有路径。而这条路**连工具都不带**、主进程的工具集里也没有读文件的那件，
       * 于是模型只能照路径编，或者说"我读不了你本机的文件"。
       *
       * 现在：把话里出现的绝对路径**读出来附在后面**（读不到就如实写"读不到"）。
       * ⚠️ 气泡里仍然显示用户的原话（`value`），内容只进请求 ——
       * 与聊天里引用画布节点是同一条规矩。
       */
      const bridge = (globalThis as unknown as { shell?: ShellBridge }).shell;
      const reads: PathRead[] = [];
      for (const path of extractFilePaths(value)) {
        const text = await Promise.resolve(bridge?.drive?.read?.(path)).catch(() => null);
        reads.push({ path, text: text ?? null });
      }
      const block = fileContextBlock(reads);
      const content = block ? `${value}

${block}` : value;

      const handle = await streamChat(
        { provider, model, messages: [{ role: "user", content }] },
        (event) => {
          turn = applyEvent(turn, event);
          if (event.type !== "text" && event.type !== "error") return;
          const view = finishTurn(turn);
          const shown = view.error ? `（出错了）${view.error}` : view.text;
          setBubbles((prev) => prev.map((b) => (b.id === replyId ? { ...b, text: shown } : b)));
        },
      );
      requestRef.current = handle.requestId;
      await handle.done;
    } catch (error) {
      const message = `（出错了）${error instanceof Error ? error.message : String(error)}`;
      setBubbles((prev) => prev.map((b) => (b.id === replyId ? { ...b, text: message } : b)));
    } finally {
      requestRef.current = null;
      setStreaming(false);
    }
  };

  return (
    <div
      className="wb-float"
      data-testid="wb-float"
      style={{ left: pos.x, top: pos.y, width: SIZE.width, height: minimized ? 40 : SIZE.height }}
    >      <div
        className="wb-float-head"
        onPointerDown={onDragStart}
        onPointerMove={onDragMove}
        onPointerUp={onDragEnd}
      >
        <button className="wb-icon" title="最小化" onClick={() => setMinimized((v) => !v)}>
          <Minus size={14} />
        </button>
        <button className="wb-icon" title="回到默认位置" onClick={() => setPos(DEFAULT_POS)}>
          ⟳
        </button>
        <span className="wb-spacer" />
        <span className="wb-float-user" data-testid="wb-float-user">
          按时吃饭450 ›
        </span>
        <button className="wb-icon" title="语音通话（按用户口径不做）" disabled>
          <Phone size={14} />
        </button>
        <button
          className="wb-icon"
          title={streaming ? "停止" : "朗读"}
          onClick={() => {
            const id = requestRef.current;
            if (id) void abortStream(id);
          }}
        >
          <Volume2 size={14} />
        </button>
        <button className="wb-icon" title="更多（本机版没有更多菜单）" disabled>
          <MoreHorizontal size={14} />
        </button>
        <button className="wb-icon" title="关闭" data-testid="wb-float-close" onClick={onClose}>
          ✕
        </button>
      </div>

      {minimized ? null : (
        <>
          <div className="wb-float-body" ref={scroller} data-testid="wb-float-body">
            {bubbles.length === 0 ? (
              <div className="wb-float-empty">
                <span className="wb-blob wb-blob-sm" aria-hidden />
                <em>随手问一句，这里不会建任务</em>
              </div>
            ) : (
              bubbles.map((bubble) =>
                bubble.role === "user" ? (
                  <div className="wb-float-user-bubble" key={bubble.id}>
                    {bubble.text}
                  </div>
                ) : (
                  <div className="wb-float-reply" key={bubble.id}>
                    {bubble.text || (streaming ? "…" : "")}
                  </div>
                ),
              )
            )}
          </div>

          <div className="wb-float-composer">
            <textarea
              className="wb-float-input"
              data-testid="wb-float-input"
              rows={2}
              placeholder="发消息或创建任务... / 使用技能 @ 添加资料"
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void send();
                }
              }}
            />
            <div className="wb-float-bar">
              <button className="wb-icon" title="添加附件（本机版还没接原生文件对话框）" disabled>
                <Plus size={15} />
              </button>
              <button className="wb-chip">
                <Sparkles size={12} /> 本地电脑
              </button>
              <button className="wb-icon" title="更多（本机版没有更多菜单）" disabled>
                <MoreHorizontal size={15} />
              </button>
              <span className="wb-spacer" />
              <span className="wb-float-level">低</span>
              <button
                className="wb-icon"
                title="语音输入"
                onClick={() => void send()}
                data-testid="wb-float-send"
                disabled={!text.trim() || streaming}
              >
                🎤
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
