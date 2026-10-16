import { useCallback, useEffect, useRef, useState } from "react";
import { Mic, Minus, Sparkles, Square, Volume2, X } from "lucide-react";
import { streamChat } from "@/ai/aiClient";
import { applyEvent, emptyTurn, finishTurn } from "@engine/core/events";
import type { ShellBridge } from "@shared/ipc";
import { extractFilePaths, fileContextBlock } from "./fileContext";
import type { PathRead } from "./fileContextTypes";
import { uiError } from "@/canvas/uiError";

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

/*
 * ⚠️ 三颗死按钮已移除（2026-10-15，M0 工单 3）：头部那颗「更多」（无更多菜单）、
 * 底栏的「添加附件」（没接原生文件对话框）与底栏又一颗「更多」。
 * 原来它们都是 `disabled` + 一句"本机版没有/还没做" —— 工单口径不允许留这种形态：
 * 要么实现、要么移除、要么降级成非交互元素。这三颗本机版都没有对应能力，所以移除。
 * 真做出来的时候它们会带着真能力回来（附件要走已经存在的那套导入通道）。
 */

type Bubble = { id: string; role: "user" | "assistant"; text: string };

/**
 * 浮窗上边不能越过的线 = 自绘标题栏的高度（`shell.css` 的 `--win-titlebar-h`）。
 *
 * 为什么要有这条下界（2026-10-15）：标题栏是窗口的拖动区，而且它压在最上面
 * （z-index 90）—— 浮窗钻进那一条就会**被它盖住**，连浮窗自己的标题栏
 * （拖动手柄 + 最小化/关闭）都一起没了。默认位置原来就是 `y: 30`，正好落在里面。
 *
 * ⚠️ 这个数**从 CSS 变量读**，不许在 TS 里再抄一遍字面量（2026-10-16 审计 P188）。
 * 原来这里是 `const FLOAT_MIN_Y = 36`，与 `shell.css` 的变量是"两处各写一遍同一个数"：
 * 把变量改成 40 / 32 之后（那是标题栏的唯一定义处），浮窗又能钻进拖动区那一条 ——
 * 正是这段注释要防的事，而守卫只读 CSS、看不见 TS 里那一份。
 */

/** 读不到变量时的兜底值（与 `shell.css` 里 `--win-titlebar-h` 的默认值一致）。 */
const FLOAT_MIN_Y_FALLBACK = 36;

/**
 * 取当前标题栏高度（px）。
 *
 * 三种"读不到"都要落到兜底值上，**绝不能返回 NaN** —— 那样
 * `Math.min/Math.max` 全变 NaN，浮窗会直接拖不动：
 * `document` 不存在（单测的 node 环境）、变量没定义（`getPropertyValue` 回空串）、
 * 变量值不是 CSS 里那个 `36px` 形状（`calc(...)` / `2.5rem` 这类 ——
 * 那时宁可退回兜底值，也不要拿"12rem 解析出来的 12"当上界：那是**悄悄算错**）。
 *
 * @returns 标题栏高度（正整数像素）
 */
export function titlebarHeight(): number {
  if (typeof document === "undefined" || typeof getComputedStyle !== "function") {
    return FLOAT_MIN_Y_FALLBACK;
  }
  const raw = getComputedStyle(document.documentElement).getPropertyValue("--win-titlebar-h");
  const px = /^\s*(\d+(?:\.\d+)?)px\s*$/.exec(raw);
  if (!px) return FLOAT_MIN_Y_FALLBACK;
  const parsed = Number.parseFloat(px[1] as string);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : FLOAT_MIN_Y_FALLBACK;
}

/** 面板默认位置（照实机量出来的比例）。`y` 落在标题栏之下，见 `titlebarHeight`。 */
const DEFAULT_X = 610;
const SIZE = { width: 400, height: 600 };

export default function FloatingAssistant({ onClose, seed }: { onClose: () => void; seed?: string }) {
  /*
   * 标题栏高度（= 拖拽上界）在**挂载时读一次**：它是给 `onDragMove`（每次 pointermove 都跑）
   * 用的，不能每帧去 `getComputedStyle`（那是同步的样式计算）。默认位置也由它算出来。
   * 取值与兜底见 `titlebarHeight`。
   */
  const [minY] = useState(titlebarHeight);
  const defaultPos = useCallback(() => ({ x: DEFAULT_X, y: minY + 12 }), [minY]);
  const [pos, setPos] = useState(defaultPos);
  const [bubbles, setBubbles] = useState<Bubble[]>([]);
  const [text, setText] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [minimized, setMinimized] = useState(false);
  const dragRef = useRef<{ dx: number; dy: number } | null>(null);
  /**
   * 这一轮的**句柄**（不是只记 id）—— 停止要调它的 `abort()`。
   *
   * ⚠️ 2026-10-16（审计 P79）：原来这里只留 `requestId`，停止走的是 `abortStream(id)`。
   * 那条路只让**主进程**断开，渲染层这条 `handle.done` **永远不会 resolve** ——
   * 于是 `await handle.done` 卡住、`finally` 里的 `setStreaming(false)` 不执行：
   * **浮窗永久卡在「生成中」**，输入框与发送键一起锁死（`send()` 第一行 `if (streaming) return`）。
   * 工作台那边早就改成 `handle.abort()` 了（`taskRuntime.ts` 里那段注释逐字写着这件事），
   * 浮窗把同一个 bug 又抄了一遍 —— 因为"怎么中止"在它这里长成了第二份实现。
   * `handle.abort()` 一次做两件：断主进程的连接 + **本地 settle**（抛一条「已中止」事件）。
   */
  const handleRef = useRef<{ abort: () => void } | null>(null);
  /** 空闲态那颗按钮是**朗读**（P80：它原来只写着"朗读"，点了什么都不做）。 */
  const [speaking, setSpeaking] = useState(false);
  const scroller = useRef<HTMLDivElement | null>(null);
  const seq = useRef(0);
  /** 上一次已经发出去的预填问题（**记文本而不是布尔**：浮窗开着时换了新问题也要发 —— P89）。 */
  const seeded = useRef("");

  /* 浮窗关掉/卸载时把朗读停掉（否则念到一半关了浮窗，声音还在） */
  useEffect(() => () => globalThis.speechSynthesis?.cancel(), []);

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

  const onDragMove = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const drag = dragRef.current;
      if (!drag) return;
      /*
       * 夹在窗口内：不夹的话面板能被拖到屏幕外，用户再也找不回来 ——
       * 一个拖不回来的浮窗比不能拖更糟。至少留 80px 在窗口里。
       * 上边另有一条下界（见 `titlebarHeight`）：不许钻进标题栏那一条。
       */
      const maxX = window.innerWidth - 80;
      const maxY = Math.max(minY, window.innerHeight - 40);
      setPos({
        x: Math.min(Math.max(0, event.clientX - drag.dx), maxX),
        y: Math.min(Math.max(minY, event.clientY - drag.dy), maxY),
      });
    },
    [minY],
  );

  const onDragEnd = useCallback(() => {
    dragRef.current = null;
  }, []);

  /**
   * 带着预填问题打开：自动发一次。
   *
   * ⚠️ 2026-10-16（审计 P89）：判据原来是 `seeded.current`（一个**布尔**）——
   * 浮窗**已经开着**时再点一次别的文件的「问问助手」，`seed` 换了新问题，
   * 而 `seeded` 早就是 true → **既不发也不填，连个回执都没有**（用户以为点了没反应）。
   * 现在记的是"**上一次吃掉的那一个问题**"：同一个问题不重复发，换了新问题就照发。
   */
  useEffect(() => {
    if (!seed || seed === seeded.current) return;
    seeded.current = seed;
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
          /*
           * ⚠️ 上游那句错误**不许原样贴上来**（2026-10-16 审计 P190）：
           * 走 `humanFailure` 的口径压成一句人话（"连不上 provider（检查网络…）"这种），
           * 认不出来的一律不把堆栈糊在气泡里 —— 见 `uiError`。
           */
          const shown = view.error ? `（出错了）${uiError(view.error)}` : view.text;
          setBubbles((prev) => prev.map((b) => (b.id === replyId ? { ...b, text: shown } : b)));
        },
      );
      /* 记**句柄**（不是 id）：停止要调 `handle.abort()`，见 handleRef 上的说明 */
      handleRef.current = handle;
      await handle.done;
    } catch (error) {
      /* 同上一处：抛出来的（SDK / 桥 / 系统）也走同一套人话，不贴 `error.message` */
      const message = `（出错了）${uiError(error)}`;
      setBubbles((prev) => prev.map((b) => (b.id === replyId ? { ...b, text: message } : b)));
    } finally {
      handleRef.current = null;
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
        <button className="wb-icon" aria-label="最小化" title="最小化" onClick={() => setMinimized((v) => !v)}>
          <Minus size={14} />
        </button>
        <button className="wb-icon" title="回到默认位置" onClick={() => setPos(defaultPos())}>
          ⟳
        </button>
        <span className="wb-spacer" />
        <span className="wb-float-user" data-testid="wb-float-user">
          本机用户 ›
        </span>
        {/*
          ⚠️ **一颗按钮，两种语义 —— 两边都得真的做事**（2026-10-16，审计 P79 + P80）：
            · 流式中 = 停止：必须走 `handleRef.current.abort()`。走 `abortStream(id)` 只断主进程，
              `handle.done` 永不 resolve → 浮窗永久卡在生成中（P79）。
            · 空闲 = 朗读：标题一直承诺「朗读」，而原来函数体里**没有任何朗读调用**（P80）——
              点了没反应，用户只会以为浮窗坏了。现在真的念最后一条助手回复（与消息操作栏那颗同一个做法）。
        */}
        <button
          className="wb-icon"
          title={streaming ? "停止" : speaking ? "停止朗读" : "朗读"}
          aria-label={streaming ? "停止" : speaking ? "停止朗读" : "朗读"}
          data-testid="wb-float-action"
          data-mode={streaming ? "stop" : "speak"}
          onClick={() => {
            if (streaming) {
              handleRef.current?.abort();
              return;
            }
            const synth = globalThis.speechSynthesis;
            if (!synth) return;
            if (speaking) {
              synth.cancel();
              setSpeaking(false);
              return;
            }
            const last = [...bubbles].reverse().find((b) => b.role === "assistant");
            if (!last?.text.trim()) return;
            const utterance = new SpeechSynthesisUtterance(last.text);
            utterance.onend = () => setSpeaking(false);
            utterance.onerror = () => setSpeaking(false);
            setSpeaking(true);
            synth.speak(utterance);
          }}
        >
          {streaming ? <Square size={13} /> : <Volume2 size={14} />}
        </button>
        <button className="wb-icon" aria-label="关闭" title="关闭" data-testid="wb-float-close" onClick={onClose}>
          <X size={12} />
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
              <button className="wb-chip">
                <Sparkles size={12} /> 本地电脑
              </button>
              <span className="wb-spacer" />
              <span className="wb-float-level">低</span>
              <button
                className="wb-icon"
                aria-label="语音输入"
                title="语音输入"
                onClick={() => void send()}
                data-testid="wb-float-send"
                disabled={!text.trim() || streaming}
              >
                <Mic size={13} />
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
