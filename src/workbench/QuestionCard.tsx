/**
 * 从 `Workbench.tsx` 拆出来的（C6-1）。**纯挪位**：一个字没改，只加了 export 与 import。
 * 拆的理由见 `docs/PLAN-C6-结构拆分.md`：那个文件 2188 行、14 个顶层组件，
 * 改一处要读两千行 —— 于是「顺手加一行」变成默认做法。
 */

import { useEffect, useState } from "react";
import { Clipboard, Plus, Volume2, X } from "lucide-react";
import { useWorkbenchStore } from "./store";
import { currentQuestion, questionProgress, type WorkTask } from "./task";

export function QuestionCard({ task }: { task: WorkTask }) {
  const answer = useWorkbenchStore((s) => s.answer);
  const question = currentQuestion(task);
  const [custom, setCustom] = useState("");

  useEffect(() => {
    setCustom("");
  }, [question?.id]);

  if (!question) return null;

  return (
    <div className="wb-question" data-testid="wb-question-card">
      <div className="wb-question-head">
        <span className="wb-question-text">{question.text}</span>
        <span className="wb-question-page">
          <span data-testid="wb-question-progress">‹ {questionProgress(task)} ›</span>
          <button className="wb-icon" aria-label="关闭" title="关闭" onClick={() => useWorkbenchStore.getState().abort()}>
            <X size={14} />
          </button>
        </span>
      </div>

      <div className="wb-options">
        {question.options.map((option, index) => (
          <button
            key={option.label}
            className="wb-option"
            data-testid={`wb-option-${index}`}
            onClick={() => void answer(option)}
          >
            <span className="wb-option-num">{index + 1}</span>
            <span className="wb-option-text">
              <b>{option.label}</b>
              {option.hint ? <em>{option.hint}</em> : null}
            </span>
            {index === 0 ? <Clipboard size={13} className="wb-option-tail" /> : null}
          </button>
        ))}
      </div>

      <div className="wb-question-foot">
        <input
          className="wb-question-input"
          data-testid="wb-custom-answer"
          placeholder="自定义描述..."
          value={custom}
          onChange={(e) => setCustom(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && custom.trim()) void answer(undefined, custom);
          }}
        />
        <button
          className="wb-icon"
          data-testid="wb-custom-send"
          disabled={!custom.trim()}
          aria-label="用这段描述回答" title="用这段描述回答"
          onClick={() => void answer(undefined, custom)}
        >
          <Plus size={15} />
        </button>
        <button className="wb-icon" aria-label="语音输入" title="语音输入（本机版还没做）" disabled>
          <Volume2 size={15} />
        </button>
      </div>
    </div>
  );
}

/* ============================================================
 * 消息操作栏（对标原版：复制/朗读/赞/踩/分享/重新生成/消耗/时间）
 * ============================================================ */

/**
 * 一条 AI 回复下方的操作栏。
 *
 * 实机是六个图标：复制 / 朗读 / 有帮助 / 没帮助 / 分享 / 重新生成 + 消耗 + 时间戳。
 *
 * **六个都要真的能用。** 原来只有「复制」是活的，其余五个点了没反应 ——
 * 那比不放这些图标更糟：用户会以为功能坏了，或者以为自己点错了地方。
 */
