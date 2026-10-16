/**
 * 从 `Workbench.tsx` 拆出来的（C6-1）。**纯挪位**：一个字没改，只加了 export 与 import。
 * 拆的理由原本记在 `docs/PLAN-C6-结构拆分.md`：那个文件 2188 行、14 个顶层组件，
 * ⚠️（该依据未入库、本机也找不到 —— 决策链断在这里，无法复核；以本文件里的断言与实现为准）
 * 改一处要读两千行 —— 于是「顺手加一行」变成默认做法。
 */

import { useState } from "react";
import { Copy, FileText, GitBranch, RotateCcw, Share2, Sparkles, ThumbsDown, ThumbsUp, Undo2, Volume2 } from "lucide-react";
import { useWorkbenchStore } from "./store";
import { writeClipboard } from "./uiUtil";
import { DOC_CREATE_LABELS } from "@shared/doc";
import { type TaskStep } from "./task";
import { REWIND_HINT } from "./checkpoint";
import { useDocStore } from "./docStore";
import { costNote } from "@shared/cost";

export function MessageActions({ taskId, step, cost, at }: { taskId: string; step: TaskStep; cost?: number; at: number }) {
  const regenerate = useWorkbenchStore((s) => s.regenerate);
  const rate = useWorkbenchStore((s) => s.rate);
  const transcript = useWorkbenchStore((s) => s.transcript);
  /** 会话检查点（§151）：回退与分叉。 */
  const rewind = useWorkbenchStore((s) => s.rewindTask);
  const branch = useWorkbenchStore((s) => s.branchTask);
  const [busy, setBusy] = useState(false);
  const [hint, setHint] = useState("");
  const [speaking, setSpeaking] = useState(false);
  const text = step.text;

  const time = new Date(at);
  const stamp = `${time.getHours()}:${String(time.getMinutes()).padStart(2, "0")}`;

  /**
   * 把这条消息变成一篇文档（§172，`aiDoc_msgLongPressMenu_createDoc` = **创建文档**）。
   *
   * 建好之后**直接跳到文档面板**并把那句说完（`aiDoc_msgToDoc_placeholder`）——
   * 只说"已创建"却让用户自己去找，等于没做完。
   */
  const createDoc = async () => {
    const id = await useDocStore.getState().createFromText(text);
    if (!id) {
      flash(DOC_CREATE_LABELS.failed);
      return;
    }
    useDocStore.getState().open(id);
    useWorkbenchStore.getState().setView("doc");
  };

  /** 提示两秒后自己消失 —— 这种小反馈不该常驻占地方。 */
  const flash = (message: string) => {
    setHint(message);
    setTimeout(() => setHint((current) => (current === message ? "" : current)), 2000);
  };

  const speak = () => {
    const synth = window.speechSynthesis;
    if (!synth) {
      flash("这台机器没有语音合成");
      return;
    }
    if (speaking) {
      synth.cancel();
      setSpeaking(false);
      return;
    }
    const utterance = new SpeechSynthesisUtterance(text);    /* 2026-10-16：不再挑音色（主人把设置里的「声音选择」拆了）—— 用系统默认那一把嗓子。 */
    utterance.onend = () => setSpeaking(false);
    utterance.onerror = () => {
      setSpeaking(false);
      flash("朗读失败");
    };
    setSpeaking(true);
    synth.speak(utterance);
  };

  return (
    <div className="wb-actions" data-testid="wb-message-actions">
      <button
        className="wb-icon"
        title="复制"
        data-testid={`wb-act-copy-${step.id}`}
        onClick={() => {
          /*
           * ⚠️ **先写成功再报喜**（2026-10-16，审计 P86）：原来是
           * `void navigator.clipboard.writeText(text); flash("已复制")` —— 不 await、不 catch，
           * 剪贴板被占用/无权限（Playwright、远程桌面、某些安全软件下常见）时，
           * 界面照样说"已复制"，而用户粘出来是**上一次的东西或空的**。
           */
          void writeClipboard(text).then((ok) => flash(ok ? "已复制" : "复制失败：剪贴板不可用"));
        }}
      >
        <Copy size={13} />
      </button>
      <button
        className={`wb-icon${speaking ? " is-on" : ""}`}
        aria-label={speaking ? "停止朗读" : "朗读"}
        title={speaking ? "停止朗读" : "朗读"}
        data-testid={`wb-act-speak-${step.id}`}
        onClick={speak}
      >
        <Volume2 size={13} />
      </button>
      <button
        className={`wb-icon${step.rating === "up" ? " is-on" : ""}`}
        aria-label="有帮助" title="有帮助"
        data-testid={`wb-act-up-${step.id}`}
        onClick={() => rate(step.id, "up")}
      >
        <ThumbsUp size={13} />
      </button>
      <button
        className={`wb-icon${step.rating === "down" ? " is-on" : ""}`}
        aria-label="没帮助" title="没帮助"
        data-testid={`wb-act-down-${step.id}`}
        onClick={() => rate(step.id, "down")}
      >
        <ThumbsDown size={13} />
      </button>
      <button
        className="wb-icon"
        title="分享（把整段对话复制成 Markdown）"
        data-testid={`wb-act-share-${step.id}`}
        onClick={() => {
          /*
           * 上位是走服务端生成分享链接。单机版没有那个后端，
           * 所以退化成"把整段对话复制成 Markdown" —— 这是**真的能拿出去用**的东西，
           * 而不是一个点了弹「暂不支持」的按钮。
           */
          const markdown = transcript();
          if (!markdown) {
            flash("没有可分享的内容");
            return;
          }
          void writeClipboard(markdown).then((ok) => flash(ok ? "对话已复制成 Markdown" : "复制失败：剪贴板不可用"));
        }}
      >
        <Share2 size={13} />
      </button>
      <button
        className="wb-icon"
        aria-label={DOC_CREATE_LABELS.create}
        title={DOC_CREATE_LABELS.create}
        data-testid={`wb-act-createdoc-${step.id}`}
        onClick={() => void createDoc()}
      >
        <FileText size={13} />
      </button>
      <button
        className={`wb-icon${busy ? " is-spin" : ""}`}
        title="重新生成"
        data-testid={`wb-act-retry-${step.id}`}
        disabled={busy}
        onClick={() => {
          setBusy(true);
          void regenerate(taskId, step.id)
            .then(() => flash("已重新生成"))
            .finally(() => setBusy(false));
        }}
      >
        <RotateCcw size={13} />
      </button>
      {/*
        会话检查点（§151）：从这里往回退、或从这里分叉。
        两件事都**只改对话**，所以 title 里把"已发生的动作不撤销"讲在明处。
      */}
      <button
        className="wb-icon"
        title={`回到这一步（之后的轮次会丢掉）。${REWIND_HINT}`}
        data-testid={`wb-act-rewind-${step.id}`}
        onClick={() => {
          /*
           * ⚠️ 同一条毛病（P86）：`rewindTask` 是 **async**，而且解析不到可回退的目标时
           * `resolveRewindTarget` 返回 null → `rewindTask` 里直接 return（**什么都没做**）——
           * 而回执照旧说"已回到这一步"。现在按**真实结果**说话。
           */
          void rewind(taskId, step.id).then((ok) => flash(ok ? "已回到这一步" : "这一步没法回退（找不到对应的提问）"));
        }}
      >
        <Undo2 size={13} />
      </button>
      <button
        className="wb-icon"
        title="从这里分叉：把到这一步为止的对话复制成一段新对话"
        data-testid={`wb-act-branch-${step.id}`}
        onClick={() => {
          branch(taskId, step.id);
          flash("已分叉成新对话");
        }}
      >
        <GitBranch size={13} />
      </button>
      {hint ? <span className="wb-act-hint" data-testid={`wb-act-hint-${step.id}`}>{hint}</span> : null}
      {typeof cost === "number" ? (
        /*
         * ⚠️ hover 里那句是**如实说明**（C5）：上面这个数是本机版按字数估的，
         * 而本体显示的是"额度"（`docs/HANDOFF.md:1695` 的实机读数写着"按额度计量，不是 token"），
         * 本机没有额度体系 —— 所以既不说它是额度，也不把单位偷偷换成 tokens。
         * provider 给的真值（tokens）跟在后面一起说出来。
         */
        <span className="wb-cost" title={costNote(cost, step.usage)}>
          <Sparkles size={12} /> 消耗 {cost.toFixed(2)}
        </span>
      ) : null}
      <span className="wb-stamp">今天 {stamp}</span>
    </div>
  );
}


/* ============================================================
 * 任务视图
 * ============================================================ */

