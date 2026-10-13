import { useEffect, useRef, useState } from "react";

/**
 * 批注文字输入框（阶段 5.1 的"文字批注"）。
 *
 * 位置由调用方给**屏幕坐标**：标记本身存在画布坐标里，但输入框是 DOM 元素，
 * 必须落到屏幕上才能对齐。宿主在提交后把文字写进标记，再清掉这个临时框。
 */
export default function MarkerTextInput({
  at,
  onSubmit,
  onCancel,
}: {
  /** 屏幕坐标（相对画布容器左上角）。 */
  at: { x: number; y: number };
  onSubmit: (text: string) => void;
  onCancel: () => void;
}) {
  const [text, setText] = useState("");
  const ref = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    ref.current?.focus();
  }, []);

  return (
    <div
      className="marker-text-input"
      style={{ left: at.x, top: at.y }}
      data-testid="marker-text-input"
    >
      <textarea
        ref={ref}
        value={text}
        placeholder="写一句批注，回车确认"
        rows={2}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            onSubmit(text);
          } else if (e.key === "Escape") {
            e.preventDefault();
            onCancel();
          }
        }}
      />
      <div className="marker-text-actions">
        <button type="button" onClick={() => onSubmit(text)}>
          确定
        </button>
        <button type="button" onClick={onCancel}>
          取消
        </button>
      </div>
    </div>
  );
}
