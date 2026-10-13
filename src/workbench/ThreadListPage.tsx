import { MoreHorizontal, Pin, Plus, PanelLeft } from "lucide-react";
import { useState } from "react";
import type { WorkTask } from "./task";
import { groupThreads, summaryOf } from "./threadGroups";
import { useLibraryStore } from "./libraryStore";
import { useWorkbenchStore } from "./store";
import ContextMenu, { type MenuItem } from "./ContextMenu";

/**
 * 「管理历史对话」页 —— 对应本体路由 `chat/thread/list`。
 *
 * 依据：`app-triage/dynamic-ui/shot-route-thread-list.png`（本体实机截图）。那一页是：
 *
 *   ┌──────────────────────────────────────────────┐
 *   │ ▯  ✎            管理历史对话               ⋯  │   ← 左：收起侧栏 / 新建；中：标题；右：更多
 *   │                                              │
 *   │  近一年                                       │   ← 时间分档
 *   │  中考升学建议            ⌾              ⋯     │   ← 标题 + 摘要（单行）+ 行内 ⋯
 *   │  版本一（31秒 爆点避坑版…                      │
 *   │  ...                                         │
 *   │  昨天                                         │
 *   │  产品周报撰写           ⌾              ⋯     │
 *   └──────────────────────────────────────────────┘
 *
 * 时间分档与摘要的规则在 `threadGroups.ts`（纯逻辑 + 13 条单测）。
 *
 * ⚠️ 两处如实说明：
 * 1. **进入这一页的入口**在截图里看不出来（截图只给了页面本身）。我把它挂在左栏
 *    「最近」分组标题右侧 —— 那是**推断**，不是从本体读到的。等有证据再改（改一处）。
 * 2. 右上那枚 ⋯ 本体里有什么**不知道**，所以按本项目的规矩**如实禁用**并写明，
 *    而不是画一个点了没反应的按钮。
 */
export default function ThreadListPage() {
  const tasks = useWorkbenchStore((s) => s.tasks);
  const setView = useWorkbenchStore((s) => s.setView);
  const openTask = useWorkbenchStore((s) => s.openTask);
  const dropTask = useWorkbenchStore((s) => s.dropTask);
  const renameTask = useWorkbenchStore((s) => s.renameTask);
  const pinned = useLibraryStore((s) => s.lib.pinned);
  const pin = useLibraryStore((s) => s.pin);

  const [menu, setMenu] = useState<{ task: WorkTask; x: number; y: number } | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  /** 「今天」以**打开这一页的时刻**为准，钉住一次：页面开着跨零点不该跳档。 */
  const [now] = useState(() => Date.now());

  const groups = groupThreads(tasks, now);

  return (
    <div className="wb-threads" data-testid="wb-threads">
      <div className="wb-threads-head">
        <button className="wb-icon" aria-label="收起侧栏" title="收起侧栏（本机版还没做折叠）" disabled>
          <PanelLeft size={15} />
        </button>
        <button className="wb-icon" aria-label="新工作任务" title="新工作任务" data-testid="wb-threads-new" onClick={() => setView("home")}>
          <Plus size={15} />
        </button>
        <span className="wb-threads-title">管理历史对话</span>
        <button className="wb-icon" aria-label="本机版还没做批量操作" title="本机版还没做批量操作" data-testid="wb-threads-more" disabled>
          <MoreHorizontal size={15} />
        </button>
      </div>

      {groups.length === 0 ? (
        <div className="wb-threads-empty" data-testid="wb-threads-empty">
          还没有对话记录 —— 在首页发一条消息，这里就会出现
        </div>
      ) : (
        groups.map((group) => (
          <div className="wb-threads-group" key={group.label} data-testid="wb-threads-group">
            <div className="wb-threads-label">{group.label}</div>
            {group.tasks.map((task) => (
              <div className="wb-threads-rowwrap" key={task.id}>
                {editing === task.id ? (
                  <input
                    className="wb-threads-rename"
                    data-testid={`wb-threads-rename-${task.id}`}
                    autoFocus
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        renameTask(task.id, draft);
                        setEditing(null);
                      }
                      if (e.key === "Escape") setEditing(null);
                    }}
                    onBlur={() => setEditing(null)}
                  />
                ) : (
                  <button className="wb-threads-row" data-testid={`wb-thread-${task.id}`} onClick={() => openTask(task.id)}>
                    <span className="wb-threads-row-top">
                      <span className="wb-threads-row-title">{task.title}</span>
                      {pinned.includes(task.id) ? (
                        <Pin size={12} className="wb-threads-pin" data-testid={`wb-thread-pinned-${task.id}`} />
                      ) : null}
                    </span>
                    <span className="wb-threads-sum">{summaryOf(task)}</span>
                  </button>
                )}
                <button
                  className="wb-threads-rowmore"
                  aria-label="更多" title="更多"
                  data-testid={`wb-threads-menu-${task.id}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    const r = e.currentTarget.getBoundingClientRect();
                    setMenu({ task, x: Math.max(8, r.right - 168), y: r.bottom + 4 });
                  }}
                >
                  <MoreHorizontal size={14} />
                </button>
              </div>
            ))}
          </div>
        ))
      )}

      {menu ? (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={[
            {
              label: pinned.includes(menu.task.id) ? "取消置顶" : "置顶",
              run: () => {
                pin(menu.task.id);
                setMenu(null);
              },
            },
            {
              label: "重命名",
              run: () => {
                setDraft(menu.task.title);
                setEditing(menu.task.id);
                setMenu(null);
              },
            },
            {
              label: "删除",
              run: () => {
                dropTask(menu.task.id);
                setMenu(null);
              },
            },
          ] satisfies MenuItem[]}
          onClose={() => setMenu(null)}
        />
      ) : null}
    </div>
  );
}
