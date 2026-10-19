import { useEffect, useState } from "react";
import { Plus, Trash2 } from "lucide-react";

import { useMemoryStore } from "./memoryStore";
import { ConfirmDialog } from "./ConfirmDialog";
import { clearConfirmRequest } from "./memoryClear";

/**
 * 「记忆」面板。
 *
 * 对应本体路由 `chat/memory/list` / `clear` / `delete` ——
 * 它**有服务端接口，说明是个真实功能**。而我原来在设置里写的是
 * "记忆需要账号服务端，本机版没有"，那是**错的**：记忆就是"用户希望长期记住的事"，
 * 存在本地一样成立（内容会随每次对话注入系统提示词，见 `memoryPromptBlock`）。
 *
 * 面板做三件事，与那三条接口一一对应：**列 / 加 / 删**，外加**清空**。
 * 顶部有一句说明它到底会做什么 —— 记忆这东西"看不见效果"最容易让人以为它没用。
 */
export default function MemoryPanel() {
  /**
   * ⚠️ `note` 也要读（2026-10-16 审计 P251）。
   *
   * `memoryStore` 的 add/drop/clear/setEnabled 一律先乐观改内存、再把**落盘结果**
   * 写进 `note`（"记下了，但存盘失败…"）—— 而全仓 `grep useMemoryStore((s) => s.note)`
   * **零命中**：落盘失败在界面上完全隐形，用户以为记下了，重启后那一条没了。
   * 这里把它显示出来（复用加载失败那句的样式，见下面的 `wb-memory-note`）。
   */
  const { lib, loaded, load, add, drop, clear, note } = useMemoryStore();
  const [draft, setDraft] = useState("");
  /** T-04：清空不可逆，必须先确认（`true` = 确认框打开） */
  const [confirming, setConfirming] = useState(false);

  useEffect(() => {
    void load();
  }, [load]);

  /**
   * 提交一条新记忆。
   *
   * @param e 表单事件
   */
  const submit = (e: React.FormEvent): void => {
    e.preventDefault();
    if (!draft.trim()) return;
    void add(draft, "manual");
    setDraft("");
  };

  return (
    <div className="wb-memory" data-testid="wb-memory">
      <div className="wb-memory-intro">
        这里记的东西会**随每次对话一起交给助手**。少而准最有用，写多了反而会分散注意力。
      </div>

      {/* 落盘/读取的如实说明（P251）：原来它写进 store 却没人读，失败在界面上完全隐形 */}
      {note ? (
        <div className="wb-memory-note" data-testid="wb-memory-note" role="status">
          {note}
        </div>
      ) : null}

      <form className="wb-memory-add" onSubmit={submit}>
        <input
          data-testid="wb-memory-input"
          value={draft}
          placeholder="例如：回答尽量简短，别用客套话"
          onChange={(e) => setDraft(e.target.value)}
        />
        <button type="submit" className="wb-icon" data-testid="wb-memory-add" aria-label="添加" title="添加" disabled={!draft.trim()}>
          <Plus size={15} />
        </button>
      </form>

      {!loaded ? (
        <div className="wb-memory-empty">正在读取…</div>
      ) : lib.entries.length === 0 ? (
        <div className="wb-memory-empty" data-testid="wb-memory-empty">
          还没有记忆。上面写一条，助手在之后的对话里就会一直记得。
        </div>
      ) : (
        <>
          <ul className="wb-memory-list" data-testid="wb-memory-list">
            {lib.entries.map((e) => (
              <li key={e.id} className="wb-memory-item" data-testid={`wb-memory-item-${e.id}`}>
                <span className="wb-memory-text">{e.text}</span>
                {e.source === "conversation" && e.fromTask ? (
                  <em className="wb-memory-from" title={`来自对话：${e.fromTask}`}>
                    {e.fromTask}
                  </em>
                ) : null}
                <button
                  className="wb-icon"
                  data-testid={`wb-memory-drop-${e.id}`}
                  aria-label="删除这条记忆" title="删除这条记忆"
                  onClick={() => void drop(e.id)}
                >
                  <Trash2 size={14} />
                </button>
              </li>
            ))}
          </ul>
          <div className="wb-memory-foot">
            <span>{lib.entries.length} 条</span>
            <button
              className="wb-page-btn"
              data-testid="wb-memory-clear"
              /* T-04：只进入确认态，**不清空**；确认之后才调 clear() */
              onClick={() => setConfirming(true)}
            >
              全部清除
            </button>
          </div>
        </>
      )}
      {confirming ? (
        <ConfirmDialog
          request={clearConfirmRequest(lib.entries.length)}
          onAnswer={(ok) => {
            setConfirming(false);
            if (ok) void clear();
          }}
        />
      ) : null}
    </div>
  );
}
