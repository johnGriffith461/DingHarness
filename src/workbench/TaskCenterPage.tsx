import { useState } from "react";
import { ExternalLink, Pin, PinOff, Trash2 } from "lucide-react";
import { useLibraryStore } from "./libraryStore";
import { useWorkbenchStore, type WorkbenchView } from "./store";
import {
  CENTER_LABELS,
  canPin,
  centerSections,
  needsStopConfirm,
  orderByPinned,
} from "./taskCenter";

/**
 * 任务中心（`chat/task-center`，§154）。
 *
 * 三块内容与全部文案逐字取自 `docs/evidence-taskcenter.txt`：  ⚠️（该依据未入库、本机也找不到 —— 无法复核；判据以本文件里的断言为准）
 * 进行中的任务 / 最近访问（置顶的排最前）/ 发现更多服务。
 *
 * 入口放在左栏「最近」那一行的头上（本体的入口在应用入口管理面板里，
 * 本机版没有那个面板 —— 这是**位置上的实现差异**，如实记在 §154）。
 */
export function TaskCenterPage() {
  const tasks = useWorkbenchStore((s) => s.tasks);
  const openTask = useWorkbenchStore((s) => s.openTask);
  const dropTask = useWorkbenchStore((s) => s.dropTask);
  const setView = useWorkbenchStore((s) => s.setView);
  const pinned = useLibraryStore((s) => s.lib.pinned);
  const pin = useLibraryStore((s) => s.pin);

  /** 正在等确认的那一条（在跑的对话，移除会把它停掉）。 */
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [toast, setToast] = useState("");

  const { ongoing, recent, more } = centerSections(tasks);
  const recentRows = orderByPinned(recent, pinned);
  const isEmpty = ongoing.length === 0 && recent.length === 0;

  const doPin = (id: string): void => {
    const verdict = canPin(pinned, id);
    if (!verdict.ok) {
      // ⭐ 满了要说出口：库里的 togglePinned 是**静默返回原对象**，界面上什么都不发生
      setToast(verdict.reason ?? "");
      return;
    }
    pin(id);
    setToast("");
  };

  const requestRemove = (id: string): void => {
    const task = tasks.find((t) => t.id === id);
    if (task && needsStopConfirm(task)) {
      setConfirmId(id);
      return;
    }
    dropTask(id);
  };

  const services: Array<{ view: WorkbenchView; label: string }> = [
    { view: "phone", label: "手机遥控电脑" },
    { view: "plugins", label: "插件 · 技能 · 伙伴" },
    { view: "scheduled", label: "定时任务" },
  ];

  return (
    <section className="wb-center" data-testid="wb-center">
      <header className="wb-center-head">
        <h2>{CENTER_LABELS.title}</h2>
        {toast ? (
          <span className="wb-center-toast" data-testid="wb-center-toast">
            {toast}
          </span>
        ) : null}
      </header>

      {isEmpty ? (
        <p className="wb-center-empty" data-testid="wb-center-empty">
          {CENTER_LABELS.empty}
          {/*
            空态给一个**明确动作**（2026-10-14 界面体检：原来只说了"这里会展示什么"，
            没说下一步干什么）。⚠️ 本体那句原话**一个字没动** ——
            `taskCenter.ts` 的文件头写着「界面文案（逐字取自证据），别顺手改措辞」，
            所以这里是**加**一句，不是改一句。
          */}
          <button className="wb-center-start" data-testid="wb-center-start" onClick={() => setView("home")}>
            开始一个新任务
          </button>
        </p>
      ) : null}

      <div className="wb-center-section" data-testid="wb-center-ongoing">
        <h3>{CENTER_LABELS.ongoing}</h3>
        {ongoing.length === 0 ? (
          <p className="wb-center-none">暂无进行中的任务</p>
        ) : (
          ongoing.map((t) => (
            <div className="wb-center-row" data-testid={`wb-center-row-${t.id}`} key={t.id}>
              <button className="wb-center-title" onClick={() => openTask(t.id)}>
                {t.title}
              </button>
              {t.stage === "awaiting" ? <em className="wb-pending">待确认</em> : null}
              <button
                className="wb-center-act"
                aria-label={CENTER_LABELS.stopDeleteDesc}
                title={CENTER_LABELS.stopDeleteDesc}
                data-testid={`wb-center-remove-${t.id}`}
                onClick={() => requestRemove(t.id)}
              >
                <Trash2 size={13} />
              </button>
            </div>
          ))
        )}
      </div>

      <div className="wb-center-section" data-testid="wb-center-recent">
        <h3>{CENTER_LABELS.recent}</h3>
        {recent.length === 0 ? (
          <p className="wb-center-none">暂无最近访问</p>
        ) : (
          recentRows.map((t) => {
            const isPinned = pinned.includes(t.id);
            return (
              <div className="wb-center-row" data-testid={`wb-center-row-${t.id}`} key={t.id}>
                <button className="wb-center-title" onClick={() => openTask(t.id)}>
                  {t.title}
                </button>
                {isPinned ? (
                  <span className="wb-center-pinned" data-testid={`wb-center-pinned-${t.id}`}>
                    已置顶
                  </span>
                ) : null}
                <button
                  className="wb-center-act"
                  title={isPinned ? CENTER_LABELS.unpin : CENTER_LABELS.pin}
                  data-testid={`wb-center-${isPinned ? "unpin" : "pin"}-${t.id}`}
                  onClick={() => (isPinned ? pin(t.id) : doPin(t.id))}
                >
                  {isPinned ? <PinOff size={13} /> : <Pin size={13} />}
                </button>
                <button
                  className="wb-center-act"
                  aria-label="移除" title="移除"
                  data-testid={`wb-center-remove-${t.id}`}
                  onClick={() => requestRemove(t.id)}
                >
                  <Trash2 size={13} />
                </button>
              </div>
            );
          })
        )}
        {more > 0 ? (
          <button
            className="wb-center-more"
            data-testid="wb-center-more"
            onClick={() => setView("threads")}
          >
            {CENTER_LABELS.viewMore}
          </button>
        ) : null}
      </div>

      <div className="wb-center-section" data-testid="wb-center-explore">
        <h3>{CENTER_LABELS.explore}</h3>
        <div className="wb-center-services">
          {services.map((s) => (
            <button
              key={s.view}
              className="wb-center-service"
              data-testid={`wb-center-service-${s.view}`}
              onClick={() => setView(s.view)}
            >
              {s.label} <ExternalLink size={12} />
            </button>
          ))}
        </div>
      </div>

      {confirmId ? (
        <div className="wb-center-confirm" data-testid="wb-center-confirm">
          <p>{CENTER_LABELS.stopDeleteDesc}</p>
          <div className="wb-center-confirm-bar">
            <button
              className="wb-center-act-text"
              data-testid="wb-center-confirm-cancel"
              onClick={() => setConfirmId(null)}
            >
              {CENTER_LABELS.cancel}
            </button>
            <button
              className="wb-center-act-text is-danger"
              data-testid="wb-center-confirm-ok"
              onClick={() => {
                dropTask(confirmId);
                setConfirmId(null);
              }}
            >
              {CENTER_LABELS.stopDelete}
            </button>
          </div>
        </div>
      ) : null}
    </section>
  );
}
