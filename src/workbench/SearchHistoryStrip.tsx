import { SEARCH_HISTORY_LABELS, type HistoryScope } from "@shared/searchHistory";
import { useSearchHistoryStore } from "./searchHistoryStore";

/**
 * 搜索历史那一条（§162）。
 *
 * 两处搜索共用：**只写一次**，免得"技能搜索的历史能删、云盘的历史不能删"这种差别。
 *
 * 只在**输入框是空的时候**才显示（`emptyOnly`）——
 * 一边筛着结果、一边挂一排历史，会让"现在到底在筛什么"变得含糊。
 */
export function SearchHistoryStrip({
  scope,
  onPick,
}: {
  scope: HistoryScope;
  /** 点某条历史：把那个词填回输入框。 */
  onPick: (query: string) => void;
}) {
  const list = useSearchHistoryStore((s) => s.history[scope]);
  const clear = useSearchHistoryStore((s) => s.clear);
  const forget = useSearchHistoryStore((s) => s.forget);

  if (!list || list.length === 0) return null;

  return (
    <div className="wb-history" data-testid={`wb-history-${scope}`}>
      <span className="wb-history-title">{SEARCH_HISTORY_LABELS.section}</span>
      {list.map((word) => (
        <span className="wb-history-chip" key={word}>
          <button
            className="wb-history-word"
            data-testid={`wb-history-${scope}-${word}`}
            onClick={() => onPick(word)}
          >
            {word}
          </button>
          <button
            className="wb-history-x"
            title={SEARCH_HISTORY_LABELS.clear}
            data-testid={`wb-history-forget-${scope}-${word}`}
            onClick={() => forget(scope, word)}
          >
            ×
          </button>
        </span>
      ))}
      <button
        className="wb-history-clear"
        data-testid={`wb-history-clear-${scope}`}
        onClick={() => clear(scope)}
      >
        {SEARCH_HISTORY_LABELS.clearAll}
      </button>
    </div>
  );
}
