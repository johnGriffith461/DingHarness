import { Send, Square } from "lucide-react";

/**
 * 输入区右下角那颗「发送 / 停止」。
 *
 * 从 `Composer.tsx` 抽出来的（那个文件有 1500 行守卫）。行为一字不变：
 * - 流式过程中是**停止**（`wb-send-stop`），点下去走 store 的 `abort()`；
 * - 空闲时**有字才有发送键**（C-01：空输入不占首屏可点名额；Enter 仍然能发）。
 */
export function ComposerSendButton({
  running,
  hasText,
  label,
  onSend,
  onStop,
}: {
  running: boolean;
  hasText: boolean;
  label?: string;
  onSend: () => void;
  onStop: () => void;
}) {
  if (running) {
    return (
      <button
        className="wb-send is-stop"
        data-testid="wb-send-stop"
        aria-label="停止"
        title="停止"
        onClick={onStop}
      >
        <Square size={14} />
      </button>
    );
  }
  if (!hasText) return null;
  return (
    <button
      className="wb-send"
      data-testid="wb-send"
      aria-label={label ?? "发送（Enter）"}
      title={label ?? "发送（Enter）"}
      onClick={onSend}
    >
      <Send size={15} />
    </button>
  );
}
