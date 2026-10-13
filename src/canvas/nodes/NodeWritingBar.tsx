import { useEffect, useRef, useState } from "react";
import { Loader, Wand2 } from "lucide-react";
import { WRITING_ACTIONS, applyWritingAction, type WritingAction } from "../canvasGenerate";
import { useRuntimeStore } from "../runtimeStore";

/**
 * 写作助手入口（对标原版 `canvas_writing_shortcuts_*`）。
 *
 * 原版把"润色 / 调长短 / 调阅读难度"放在文本内容附近的入口按钮里，点一下就地改写当前文字。
 * 这里同样挂在节点头部：一个「写作」按钮展开四个动作，改的是**这个节点自己的内容**
 * （不像「AI 生成」那样落新节点）。
 *
 * 与生成共用同一套链路与状态：改完会追加一个生成版本，所以改坏了还能从版本历史回退。
 */
export default function NodeWritingBar({ nodeId }: { nodeId: string }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<WritingAction | null>(null);
  const [error, setError] = useState<string | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  // 点外面收起
  useEffect(() => {
    if (!open) return;
    const onClick = (event: MouseEvent) => {
      if (wrapRef.current?.contains(event.target as Node)) return;
      setOpen(false);
    };
    window.addEventListener("mousedown", onClick);
    return () => window.removeEventListener("mousedown", onClick);
  }, [open]);

  const run = async (action: WritingAction) => {
    setOpen(false);
    setBusy(action);
    setError(null);
    // 改文字前先打一个撤销点，这样 Ctrl+Z 能回到改写前
    useRuntimeStore.getState().commitHistory();
    const result = await applyWritingAction(nodeId, action);
    setBusy(null);
    if (result.error) setError(result.error);
  };

  return (
    <div className="nv-write nodrag" ref={wrapRef}>
      <button
        className="nv-btn"
        data-testid={`writing-entry-${nodeId}`}
        title="写作助手：润色 / 写长 / 写短 / 更通俗"
        onClick={() => setOpen((prev) => !prev)}
        disabled={busy !== null}
      >
        {busy ? <Loader size={11} className="nv-spin" /> : <Wand2 size={11} />}
        写作
      </button>

      {open ? (
        <div className="nv-menu nv-write-menu" data-testid={`writing-menu-${nodeId}`}>
          {WRITING_ACTIONS.map((action) => (
            <button
              key={action.id}
              className="nv-menu-item"
              data-writing-action={action.id}
              title={action.hint}
              onClick={() => void run(action.id)}
            >
              {action.label}
            </button>
          ))}
        </div>
      ) : null}

      {error ? (
        <div className="nv-write-error" title="点击关闭" onClick={() => setError(null)}>
          {error}
        </div>
      ) : null}
    </div>
  );
}
