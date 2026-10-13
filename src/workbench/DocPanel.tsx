import { useState } from "react";
import { Check, Clock, Copy, Download, History, Plus, Trash2 } from "lucide-react";
import {
  DOC_ACTIONS,
  DOC_ACTION_LABEL,
  DOC_SAVED_LABEL,
  DOC_TEXT_PLACEHOLDER,
  DOC_TITLE_PLACEHOLDER,
  DOC_TITLE_LIMIT,
  DOC_WRITING_LABEL,
  docTitle,
  versionStamp,
} from "@shared/doc";
import { useDocStore } from "./docStore";
import {
  DOC_FORMATS,
  DOC_FORMAT_LABEL,
  DOC_KEYBOARD_LABELS,
  DOC_TONES,
  DOC_TONE_LABEL,
  type DocFormat,
} from "@shared/docFormat";
import { DOC_BAR_LABELS } from "@shared/doc";

/**
 * AI 文档面板（§153）。
 *
 * ## 文案全部逐字取自本体
 *
 * 见 `docs/evidence-aidoc.txt`（124 条 `aiDoc_*`，从本体前端包抠出来的）。
 * 对应路由 `/chat/new-doc` 与 `/chat/write`。
 *
 * ## 与画布"写作助手"的区别
 *
 * 画布那个改的是**选中节点的文字**（就地改）；这里是**一整篇文档**：
 * 有自己的标题、状态、历史版本、导出。
 */
export function DocPanel() {
  const docs = useDocStore((s) => s.docs);
  const activeId = useDocStore((s) => s.activeId);
  const busy = useDocStore((s) => s.busy);
  const note = useDocStore((s) => s.note);
  const create = useDocStore((s) => s.create);
  const open = useDocStore((s) => s.open);
  const patch = useDocStore((s) => s.patch);
  const restore = useDocStore((s) => s.restore);
  const runAction = useDocStore((s) => s.runAction);
  const runTone = useDocStore((s) => s.runTone);
  const applyFormatTo = useDocStore((s) => s.applyFormatTo);
  const pasteInto = useDocStore((s) => s.pasteInto);
  const attachTo = useDocStore((s) => s.attachTo);
  const exportDoc = useDocStore((s) => s.exportDoc);
  const remove = useDocStore((s) => s.remove);

  const [showHistory, setShowHistory] = useState(false);
  /** 现在开着哪个菜单（`null` = 都关着）。 */
  const [menu, setMenu] = useState<"tone" | "tools" | null>(null);
  /**
   * 正文里的选区。
   *
   * ⚠️ 调整格式要**按选区**动（用户选了一段小标题，就只给那几行加 `##`）——
   * 拿不到选区就只能动整篇，那是另一件事。
   */
  const [selRange, setSelRange] = useState<{ start: number; end: number } | undefined>(undefined);
  /**
   * 「插入附件」列的是**云盘里的文件**（§173）。
   *
   * 为什么不弹系统文件框：插进文档的应当是"已经在云盘里的东西" ——
   * 那条链接指向 `dshasset://file/<origin>/<名字>`，只有云盘里的文件才解析得到。
   * （顺带：不弹框也让这件事能被自动化验。）
   */
  const [attaches, setAttaches] = useState<Array<{ name: string; origin: string }> | null>(null);

  const openAttach = () => {
    setAttaches([]);
    const shell = (globalThis as unknown as { shell?: { drive?: { list: () => Promise<Array<{ name: string; origin: string }>> } } }).shell;
    void shell?.drive
      ?.list()
      .then((list) => setAttaches(list.map((f) => ({ name: f.name, origin: f.origin }))))
      .catch(() => setAttaches([]));
  };
  const doc = docs.find((d) => d.id === activeId) ?? null;

  if (!doc) {
    return (
      <section className="wb-doc" data-testid="wb-doc">
        <div className="wb-doc-empty" data-testid="wb-doc-empty">
          <p>开启你的第一篇 AI 文档</p>
          <button className="wb-doc-primary" data-testid="wb-doc-create" onClick={() => void create()}>
            <Plus size={14} /> 新建文档
          </button>
        </div>
      </section>
    );
  }

  return (
    <section className="wb-doc" data-testid="wb-doc">
      {/* 左：文档列表（本体 `aiDoc_chatList_subTitle` =「点击查看文档」） */}
      <aside className="wb-doc-list" data-testid="wb-doc-list">
        <header>
          <span>文档</span>
          <button className="wb-doc-icon" aria-label="新建文档" title="新建文档" data-testid="wb-doc-new" onClick={() => void create()}>
            <Plus size={14} />
          </button>
        </header>
        {docs.length === 0 ? (
          <p className="wb-doc-list-empty">还没有文档</p>
        ) : (
          [...docs]
            .reverse()
            .map((d) => (
              <button
                key={d.id}
                className={`wb-doc-list-item${d.id === activeId ? " is-on" : ""}`}
                data-testid={`wb-doc-item-${d.id}`}
                onClick={() => open(d.id)}
              >
                {docTitle(d)}
              </button>
            ))
        )}
      </aside>

      <div className="wb-doc-main">
        <header className="wb-doc-head">
          <input
            className="wb-doc-title"
            data-testid="wb-doc-title"
            value={doc.title}
            placeholder={DOC_TITLE_PLACEHOLDER}
            maxLength={DOC_TITLE_LIMIT * 3}
            onChange={(e) => patch(doc.id, { title: e.target.value }, "编辑标题")}
          />
          {/* 状态：撰写中… / 已保存（本体 `aiDoc_writing_hint` / `aiDoc_titleBar_saved`） */}
          <span className="wb-doc-status" data-testid="wb-doc-status">
            {busy ? (
              <>
                <Clock size={12} /> {DOC_WRITING_LABEL}
              </>
            ) : (
              <>
                <Check size={12} /> {DOC_SAVED_LABEL}
              </>
            )}
          </span>
          <span className="wb-doc-actions">
            <button
              className="wb-doc-icon"
              aria-label="历史记录" title="历史记录"
              data-testid="wb-doc-history-btn"
              onClick={() => setShowHistory((v) => !v)}
            >
              <History size={14} />
            </button>
            <button
              className="wb-doc-icon"
              title="复制全文"
              data-testid="wb-doc-copy"
              onClick={() => {
                void navigator.clipboard.writeText(doc.body);
                useDocStore.setState({ note: "已复制全文" });
              }}
            >
              <Copy size={14} />
            </button>
            <button
              className="wb-doc-icon"
              aria-label="导出文件" title="导出文件"
              data-testid="wb-doc-export"
              onClick={() => void exportDoc(doc.id)}
            >
              <Download size={14} />
            </button>
            <button
              className="wb-doc-icon"
              aria-label="删除" title="删除"
              data-testid="wb-doc-delete"
              onClick={() => void remove(doc.id)}
            >
              <Trash2 size={14} />
            </button>
          </span>
        </header>

        {showHistory ? (
          <div className="wb-doc-history" data-testid="wb-doc-history">
            <div className="wb-doc-history-head">历史记录</div>
            {[...doc.versions].reverse().map((v, i) => (
              <div className="wb-doc-version" key={v.v}>
                <span className="wb-doc-version-name">
                  {i === 0 ? "最新版" : `v${v.v}`} · {versionStamp(v.at)}
                </span>
                <span className="wb-doc-version-reason">{v.reason}</span>
                {i === 0 ? null : (
                  <button
                    className="wb-doc-restore"
                    data-testid={`wb-doc-restore-${v.v}`}
                    onClick={() => restore(doc.id, v.v)}
                  >
                    回到此版本
                  </button>
                )}
              </div>
            ))}
          </div>
        ) : null}

        <textarea
          className="wb-doc-body"
          data-testid="wb-doc-body"
          value={doc.body}
          placeholder={DOC_TEXT_PLACEHOLDER}
          spellCheck={false}
          onChange={(e) => patch(doc.id, { body: e.target.value }, "编辑正文")}
          onSelect={(e) => {
            const el = e.currentTarget;
            setSelRange({ start: el.selectionStart ?? 0, end: el.selectionEnd ?? 0 });
          }}
        />

        {/* 操作条：四个动作的文案逐字取自 `aiDoc_actionBar_*` */}
        <footer className="wb-doc-bar">
          {DOC_ACTIONS.map((a) => (
            <button
              key={a}
              className="wb-doc-chip"
              data-testid={`wb-doc-act-${a}`}
              disabled={busy || !doc.body.trim()}
              onClick={() => void runAction(doc.id, a)}
            >
              {DOC_ACTION_LABEL[a]}
            </button>
          ))}
          {/* 粘贴（§173）：走主进程剪贴板，插到选区处 */}
          <button
            className="wb-doc-chip"
            data-testid="wb-doc-paste"
            onClick={() => void pasteInto(doc.id, selRange)}
          >
            {DOC_BAR_LABELS.paste}
          </button>
          {/* 插入附件（§173）：列云盘里的文件，插一条 `dshasset://` 链接 */}
          <span className="wb-doc-menuwrap">
            <button
              className="wb-doc-chip"
              data-testid="wb-doc-attach"
              onClick={() => {
                if (attaches) setAttaches(null);
                else openAttach();
              }}
            >
              {DOC_BAR_LABELS.attach}
            </button>
            {attaches ? (
              <span className="wb-doc-pop" data-testid="wb-doc-attach-pop">
                {attaches.length === 0 ? (
                  <span className="wb-doc-pop-empty" data-testid="wb-doc-attach-empty">
                    云盘里还没有文件
                  </span>
                ) : (
                  attaches.map((f) => (
                    <button
                      key={f.name}
                      className="wb-doc-pop-item"
                      data-testid={`wb-doc-attach-${f.name}`}
                      onClick={() => {
                        attachTo(doc.id, selRange, f);
                        setAttaches(null);
                      }}
                    >
                      {f.name}
                    </button>
                  ))
                )}
              </span>
            ) : null}
          </span>
          {/*
            调整语气 / 调整格式（§168）：文案逐字取自 `aiDoc_keyboard_actionBar_*`。
            两者实现不同 —— 语气要调模型，格式是**纯本地变换**。
          */}
          <span className="wb-doc-menuwrap">
            <button
              className="wb-doc-chip"
              data-testid="wb-doc-tone"
              disabled={busy || !doc.body.trim()}
              onClick={() => setMenu((cur) => (cur === "tone" ? null : "tone"))}
            >
              {DOC_KEYBOARD_LABELS.tone}
            </button>
            {menu === "tone" ? (
              <span className="wb-doc-pop" data-testid="wb-doc-tone-pop">
                {DOC_TONES.map((k) => (
                  <button
                    key={k}
                    className="wb-doc-pop-item"
                    data-testid={`wb-doc-tone-${k}`}
                    onClick={() => {
                      setMenu(null);
                      void runTone(doc.id, k);
                    }}
                  >
                    {DOC_TONE_LABEL[k]}
                  </button>
                ))}
              </span>
            ) : null}
          </span>
          <span className="wb-doc-menuwrap">
            <button
              className="wb-doc-chip"
              data-testid="wb-doc-tools"
              onClick={() => setMenu((cur) => (cur === "tools" ? null : "tools"))}
            >
              {DOC_KEYBOARD_LABELS.tools}
            </button>
            {menu === "tools" ? (
              <span className="wb-doc-pop" data-testid="wb-doc-tools-pop">
                {DOC_FORMATS.map((k: DocFormat) => (
                  <button
                    key={k}
                    className="wb-doc-pop-item"
                    data-testid={`wb-doc-tools-${k}`}
                    onClick={() => {
                      setMenu(null);
                      applyFormatTo(doc.id, k, selRange);
                    }}
                  >
                    {DOC_FORMAT_LABEL[k]}
                  </button>
                ))}
              </span>
            ) : null}
          </span>
          {note ? (
            <span className="wb-doc-note" data-testid="wb-doc-note">
              {note}
            </span>
          ) : null}
        </footer>
      </div>
    </section>
  );
}
