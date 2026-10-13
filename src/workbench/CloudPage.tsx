/**
 * 从 `pages.tsx` 拆出来的（C6-2）。**纯挪位**：一个字没改，只加了 export 与 import。
 * 拆分理由见 `docs/PLAN-C6-结构拆分.md`（那个文件 1669 行 / 7 个顶层组件）。
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import type { ShellBridge } from "@shared/ipc";
import { countByKind, DRIVE_KIND_META, formatBytes, formatDriveTime, selectEntries, type DriveEntry, type DriveKind, type DriveTab, ORIGIN_LABEL } from "@shared/drive";
import { RENAME_LABELS, isTextKind, planRename } from "@shared/driveFiles";
import { DOWNLOAD_LABELS, downloadNote } from "@shared/driveOps";
import { emptyLabelFor, placeholderFor } from "@shared/search";
import { SearchHistoryStrip } from "./SearchHistoryStrip";
import { UPLOAD_HINTS } from "@shared/upload";
import { UploadPanel } from "./UploadPanel";
import { useUploadStore } from "./uploadStore";
import { useSearchHistoryStore } from "./searchHistoryStore";
import { deleteConfirmTitle, DRIVE_LABELS, DRIVE_SORTS, DRIVE_SORT_LABEL, DRIVE_TABS, DRIVE_TAB_LABEL, emptyTextFor, filterByKind, filterByQuery, kindOptions, sortEntries, storageLine, untitledName, validateDriveName, type DriveSort } from "@shared/driveOps";
import { FileText, FolderOpen, Grid3x3, List, Plus, Search, Upload } from "lucide-react";
import { useLibraryStore } from "./libraryStore";
import { useReaderStore } from "./readerStore";
import { useWorkbenchStore } from "./store";
import { clampMenu } from "./ContextMenu";

import { DriveRowMenu } from "./DriveRowMenu";

export function CloudPage() {
  const [tab, setTab] = useState<DriveTab>("recent");
  const [entries, setEntries] = useState<DriveEntry[]>([]);
  const [grid, setGrid] = useState(false);
  /*
   * 收藏统一放在本机库（`library.json`）里，不再单独用 localStorage。
   * 原来那条 `dsh-canvas.drive-starred` 是第二份状态 —— 两份状态迟早对不上。
   */
  const starredList = useLibraryStore((s) => s.lib.starredFiles);
  const star = useLibraryStore((s) => s.star);
  const starred = useMemo(() => new Set(starredList), [starredList]);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");

  /**
   * 正在往云盘上拖东西（§171）。
   *
   * ⚠️ `dragleave` 在拖过子元素时也会触发 —— 只看它会让高亮乱闪。
   * 这里用"计数"的办法：进来 +1、出去 -1，归零才算真的离开。
   */
  const [dragDepth, setDragDepth] = useState(0);

  /** 一次拖拽的收尾动作（`importData` 那条路，内容导入）。 */
  const onDropFiles = (files: File[]) => {
    setDragDepth(0);
    if (files.length === 0) return;
    void (async () => {
      await useUploadStore.getState().startFiles(files);
      await refresh();
    })();
  };
  const [now] = useState(() => Date.now());

  /**
   * 重新读一遍云盘列表。
   *
   * @param keepNote 成功后**保留**提示栏上已有的那句话（默认清空）。
   *
   * ── 为什么要有这个参数（2026-10-14）─────────────────────────────
   * 原来成功分支无条件 `setNote("")`，于是"先报回执、再刷新"的调用方
   * **回执照样被自己的刷新吃掉**：菜单里点「复制链接」→ `onChanged` 设
   * 「已复制链接」→ 紧接着 `refresh()` 跑完把它清掉。本地刷新是毫秒级的，
   * 用户根本看不见那句话 —— 点了没反应（只是恰好剪贴板里真有东西）。
   * 验收 `accept-context` 里那条「复制完没有任何回执」就是这么红的。
   *
   * @returns 这次读取成没成（失败时提示栏已经是错误信息，调用方别再覆盖）
   */
  const refresh = useCallback(async (keepNote = false): Promise<boolean> => {
    const bridge = (window as unknown as { shell?: ShellBridge }).shell;
    if (!bridge?.drive) {
      setNote("云盘通道不可用：请用 Electron 启动应用");
      return false;
    }
    setBusy(true);
    try {
      const list = await bridge.drive.list();
      // 主进程给的是字符串型 kind，这里收窄成联合类型（两边共用同一套枚举）
      setEntries(list as DriveEntry[]);
      if (!keepNote) setNote("");
      return true;
    } catch (error) {
      setNote(`读取云盘失败：${error instanceof Error ? error.message : String(error)}`);
      return false;
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  /* 筛选与排序（§157）：本体是「筛选（所有类型）」+「自定义排序（正序/倒序）」两个控件 */
  const [kindFilter, setKindFilter] = useState<DriveKind | "all">("all");
  const [sortKey, setSortKey] = useState<DriveSort | null>(null);
  const [desc, setDesc] = useState(false);
  /* 新建：本体是一个菜单（新建文档 / 新建文件夹 / 新建 PPT） */
  const [newMenu, setNewMenu] = useState(false);

  /* 云盘搜索（§160）：`drive_searchWindow_placeholder` = 搜索文件 */
  const [fileQuery, setFileQuery] = useState("");
  const recordSearch = useSearchHistoryStore((s) => s.record);
  const commitFileQuery = (): void => {
    if (fileQuery.trim()) recordSearch("files", fileQuery);
  };
  /* 删除确认与重命名（§158）：两个都要对话框，删文件不可逆、改名会影响引用 */
  const [confirmDel, setConfirmDel] = useState<DriveEntry | null>(null);
  const [renameOf, setRenameOf] = useState<DriveEntry | null>(null);
  const [renameText, setRenameText] = useState("");
  const [renameError, setRenameError] = useState("");

  /*
   * 列表流水线（§157）：**标签页 → 筛选 → 排序**，三步都是纯函数。
   * 顺序不能换：先按标签页取集合，再筛类目，最后排序 ——
   * 反过来的话，"最近"里的排序会被筛选打乱。
   */
  const visible = useMemo(() => {
    const byTab = selectEntries(entries, tab, starred);
    const kept = filterByKind(filterByQuery(byTab, fileQuery), kindFilter);
    // 没手动选排序时，用标签页自己的口径（selectEntries 已经排好了）
    return sortKey ? sortEntries(kept, sortKey, desc) : kept;
  }, [entries, tab, starred, kindFilter, sortKey, desc, fileQuery]);
  const counts = useMemo(() => countByKind(entries), [entries]);

  const toggleStar = (name: string) => star(name);

  /* 右键菜单：记下坐标与目标行 */
  const [menu, setMenu] = useState<{ entry: DriveEntry; x: number; y: number } | null>(null);

  const bridge = (window as unknown as { shell?: ShellBridge }).shell;

  return (
    <section className="wb-page" data-testid="wb-page-cloud">
      <header className="wb-page-head">
        {/* 侧栏折叠：本机版还没做（参考实现里有）—— 标 disabled，不装作能用（§125/§126） */}
<button className="wb-icon" aria-label="打开/收起左侧栏" title="打开/收起左侧栏（本机版还没做折叠）" disabled>
          <List size={15} />
        </button>
        <div className="wb-tabs">
          {(
            // 证据里的四个 + 本机版的「收藏」（只增不减，§157）
            [...DRIVE_TABS, "starred" as const].map((id) => [id, DRIVE_TAB_LABEL[id]] as const)
          ).map(([id, label]) => (
            <button
              key={id}
              className={`wb-tab${tab === id ? " is-on" : ""}`}
              data-testid={`wb-cloud-tab-${id}`}
              onClick={() => setTab(id)}
            >
              {label}
            </button>
          ))}
        </div>
        <span className="wb-spacer" />
        <span className="wb-cloud-count" data-testid="wb-cloud-count">
          {entries.length} 个文件
          {Object.keys(counts).length > 0
            ? `（${Object.entries(counts)
                .map(([k, v]) => `${DRIVE_KIND_META[k as DriveKind]?.label ?? k} ${v}`)
                .join(" / ")}）`
            : ""}
        </span>
        <button className="wb-icon" title="刷新" data-testid="wb-cloud-refresh" onClick={() => void refresh()}>
          {busy ? "…" : "⟳"}
        </button>
        <button
          className="wb-page-btn"
          data-testid="wb-cloud-upload"
          /*
           * 「上传」走 uploadStore（§170）：它先把任务摆成"正在上传"，
           * 拿到**按文件**的结果之后再逐条落成已完成 / 失败 —— 这样才有状态面板可看。
           */
          onClick={() => {
            void (async () => {
              await useUploadStore.getState().startDialog();
              await refresh();
            })();
          }}
        >
          <Upload size={13} /> 上传
        </button>        <div className="wb-cloud-newbox">
          <button
            className="wb-page-btn"
            data-testid="wb-cloud-new"
            onClick={() => setNewMenu((v) => !v)}
          >
            <Plus size={14} /> {DRIVE_LABELS.addNew}
          </button>
          {newMenu ? (
            <div className="wb-cloud-newmenu" data-testid="wb-cloud-newmenu">
              {(
                [
                  ["doc", DRIVE_LABELS.newDoc],
                  ["folder", DRIVE_LABELS.newFolder],
                  ["slides", DRIVE_LABELS.newSlides],
                ] as const
              ).map(([kind, label]) => (
                <button
                  key={kind}
                  className="wb-cloud-newmenu-item"
                  data-testid={`wb-cloud-new-${kind}`}
                  onClick={() => {
                    setNewMenu(false);
                    void (async () => {
                      if (!bridge?.drive) return;
                      const names = entries.map((x) => x.name);
                      /*
                       * 名字用一个输入框问（本体是个正经的命名弹窗 `drive_newFolder_header`
                       * + `请输入文件夹名称`；本机版先用 prompt 顶着，类型选择走上面的菜单）。
                       * 默认名由 `untitledName` 给 —— 重名加序号，**绝不覆盖**。
                       */
                      const raw = window.prompt(
                        kind === "folder" ? DRIVE_LABELS.folderNamePlaceholder : "新建文件",
                        untitledName(kind, names),
                      );
                      if (raw === null) return;
                      const name = raw.trim() || untitledName(kind, names);
                      const verdict = validateDriveName(name);
                      if (verdict) {
                        setNote(verdict);
                        return;
                      }
                      if (kind === "folder") {
                        const made = await bridge.drive.mkdir(name);
                        setNote(made ? `已新建 ${made}` : "新建文件夹失败（可能已存在）");
                      } else {
                        const body =
                          kind === "slides"
                            ? `# ${name.replace(/\.md$/i, "")}\n\n## 第一页\n\n## 第二页\n`
                            : `# ${name.replace(/\.md$/i, "")}\n\n`;
                        const made = await bridge.drive.create(name, body);
                        setNote(made ? `已新建 ${made}` : "新建失败（名字里不能有路径分隔符）");
                      }
                      await refresh();
                    })();
                  }}
                >
                  {label}
                </button>
              ))}
            </div>
          ) : null}
        </div>
      </header>

      <div className="wb-page-body wb-page-flush">
        {/* 上传任务面板（§170）：没有任务时它自己不显示 */}
        <UploadPanel />

        {/*
          拖拽上传（§171）：整页接管拖放 —— 拖到哪儿都算数，不用瞄准一个小框。
          ⚠️ 文案不编新词：证据里没有"拖进来/松开"这类话，
          所以角标上用已有的 `drive_upload_file`（上传文件）。
        */}
        <div
          className={dragDepth > 0 ? "wb-cloud-drop is-over" : "wb-cloud-drop"}
          data-testid="wb-cloud-drop"
          onDragEnter={(e) => {
            e.preventDefault();
            setDragDepth((d) => d + 1);
          }}
          onDragOver={(e) => e.preventDefault()}
          onDragLeave={() => setDragDepth((d) => Math.max(0, d - 1))}
          onDrop={(e) => {
            e.preventDefault();
            onDropFiles(Array.from(e.dataTransfer?.files ?? []));
          }}
        >
          {dragDepth > 0 ? <span className="wb-cloud-drop-hint">{UPLOAD_HINTS.file}</span> : null}
        </div>

        <div className="wb-cloud-tools">
          <span className="wb-spacer" />
          {note ? (
            <span className="wb-cloud-note" data-testid="wb-cloud-note">
              {note}
            </span>
          ) : null}
          <label className="wb-searchbox" data-testid="wb-cloud-searchbox">
            <Search size={13} />
            <input
              data-testid="wb-cloud-search"
              value={fileQuery}
              placeholder={placeholderFor("files")}
              onChange={(e) => setFileQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") commitFileQuery();
              }}
              onBlur={commitFileQuery}
            />
          </label>
          {fileQuery ? null : <SearchHistoryStrip scope="files" onPick={setFileQuery} />}
          <label className="wb-cloud-filter" title={DRIVE_LABELS.filter}>
            <select
              data-testid="wb-cloud-filter"
              value={kindFilter}
              onChange={(e) => setKindFilter(e.target.value as DriveKind | "all")}
            >
              {kindOptions().map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
          <label className="wb-cloud-filter" title={DRIVE_LABELS.customSort}>
            <select
              data-testid="wb-cloud-sort"
              value={sortKey ?? ""}
              onChange={(e) => setSortKey((e.target.value || null) as DriveSort | null)}
            >
              <option value="">{DRIVE_LABELS.customSort}</option>
              {DRIVE_SORTS.map((k) => (
                <option key={k} value={k}>
                  {DRIVE_SORT_LABEL[k]}
                </option>
              ))}
            </select>
          </label>
          <button
            className="wb-icon"
            title={desc ? DRIVE_LABELS.ascend : DRIVE_LABELS.descend}
            data-testid="wb-cloud-sort-dir"
            onClick={() => setDesc((v) => !v)}
          >
            {desc ? "↓" : "↑"}
          </button>
          <button className={`wb-icon${grid ? "" : " is-on"}`} onClick={() => setGrid(false)} title="列表">
            <List size={14} />
          </button>
          <button className={`wb-icon${grid ? " is-on" : ""}`} onClick={() => setGrid(true)} title="网格">
            <Grid3x3 size={14} />
          </button>
        </div>

        {visible.length === 0 ? (
          <div className="wb-cloud-empty" data-testid="wb-cloud-empty">
            {tab === "starred"
              ? "还没有收藏的文件（点文件名旁的 ☆ 收藏）"
              : entries.length === 0
                ? emptyTextFor(kindFilter)
                : /* 有搜索结果这一说的时候，说清"是这一搜没有"（`drive_searchWindow_result_empty`） */
                  emptyLabelFor("files", visible.length) || "这个筛选下没有文件"}
          </div>
        ) : (
          <div className={`wb-table${grid ? " is-grid" : ""}`} data-testid="wb-cloud-table">
            <div className="wb-tr wb-th">
              <span>名称</span>
              <span>文件类型</span>
              <span>文件大小</span>
              <span>创建时间</span>
              <span>最近修改</span>
              <span />
            </div>
            {visible.map((entry) => (
              <div
                className="wb-tr"
                key={entry.path}
                data-testid={`wb-file-${entry.name}`}
                onContextMenu={(e) => {
                  e.preventDefault();
                  // 菜单靠右下角时会跑出窗口，夹一下
                  setMenu({ entry, ...clampMenu(e.clientX, e.clientY) });
                }}
              >
                <span className="wb-td-name">
                  <FileText size={14} />
                  <button
                    className="wb-td-link"
                    title={entry.path}
                    data-testid={`wb-open-${entry.name}`}
                    onClick={async () => {
                      if (!bridge?.drive) return;
                      const error = await bridge.drive.open(entry.path);
                      if (error) setNote(`打不开：${error}`);
                    }}
                  >
                    {entry.name}
                  </button>
                  {/* 来源标签走一处映射：加一个来源不必再回来改这里（§166） */}
                  {ORIGIN_LABEL[entry.origin] ? (
                    <em className="wb-td-from">{ORIGIN_LABEL[entry.origin]}</em>
                  ) : null}
                </span>
                <span>
                  <span className={`wb-kind ${DRIVE_KIND_META[entry.kind].tone}`}>
                    {DRIVE_KIND_META[entry.kind].label}
                  </span>
                </span>
                <span className="wb-td-num">{formatBytes(entry.bytes)}</span>
                <span>{formatDriveTime(entry.createdAt, now)}</span>
                <span>{formatDriveTime(entry.modifiedAt, now)}</span>
                <span className="wb-td-more">
                  <button
                    className="wb-icon"
                    title={starred.has(entry.name) ? "取消收藏" : "收藏"}
                    data-testid={`wb-star-${entry.name}`}
                    onClick={() => toggleStar(entry.name)}
                  >
                    {starred.has(entry.name) ? "★" : "☆"}
                  </button>
                  <button
                    className="wb-icon"
                    aria-label="在文件夹里定位" title="在文件夹里定位"
                    onClick={() => void bridge?.drive?.reveal(entry.path)}
                  >
                    <FolderOpen size={12} />
                  </button>
                  <button
                    className="wb-icon"
                    title="从云盘删除"
                    data-testid={`wb-del-${entry.name}`}
                    onClick={() => setConfirmDel(entry)}
                  >
                    ×
                  </button>
                </span>
              </div>
            ))}
          </div>
        )}

        {/* 到底了（`drive_page_end`）+ 已使用多少（`drive_storage_used`） */}
        {visible.length > 0 ? (
          <div className="wb-cloud-end" data-testid="wb-cloud-page-end">
            已经到底了
          </div>
        ) : null}
        <div className="wb-cloud-foot">
          <span data-testid="wb-cloud-storage">
            {storageLine(
              entries.reduce((sum, x) => sum + x.bytes, 0),
              formatBytes,
            )}
          </span>
          <span className="wb-spacer" />
          使用云盘，代表你已阅读并同意 云盘使用须知
        </div>
      </div>

      {confirmDel ? (
        <div className="wb-cloud-dialog" data-testid="wb-cloud-confirm">
          <p data-testid="wb-cloud-confirm-title">{deleteConfirmTitle(confirmDel)}</p>
          <p className="wb-cloud-dialog-sub">{confirmDel.name}</p>
          <div className="wb-cloud-dialog-bar">
            <button
              className="wb-agent-cancel"
              data-testid="wb-cloud-confirm-cancel"
              onClick={() => setConfirmDel(null)}
            >
              取消
            </button>
            <button
              className="wb-agent-start"
              data-testid="wb-cloud-confirm-ok"
              onClick={() => {
                const target = confirmDel;
                setConfirmDel(null);
                void (async () => {
                  if (!bridge?.drive) return;
                  const ok = await bridge.drive.remove(target.path);
                  setNote(ok ? `已删除 ${target.name}` : "删除失败");
                  if (ok) await refresh();
                })();
              }}
            >
              删除
            </button>
          </div>
        </div>
      ) : null}

      {renameOf ? (
        <div className="wb-cloud-dialog" data-testid="wb-cloud-rename">
          <p>{RENAME_LABELS.title}</p>
          <input
            className="wb-cloud-dialog-input"
            data-testid="wb-cloud-rename-input"
            value={renameText}
            placeholder={RENAME_LABELS.title}
            onChange={(e) => {
              setRenameText(e.target.value);
              setRenameError("");
            }}
          />
          {renameError ? (
            <p className="wb-cloud-dialog-err" data-testid="wb-cloud-rename-err">
              {renameError}
            </p>
          ) : null}
          <div className="wb-cloud-dialog-bar">
            <button
              className="wb-agent-cancel"
              data-testid="wb-cloud-rename-cancel"
              onClick={() => setRenameOf(null)}
            >
              {RENAME_LABELS.cancel}
            </button>
            <button
              className="wb-agent-start"
              data-testid="wb-cloud-rename-ok"
              onClick={() => {
                const target = renameOf;
                const plan = planRename(
                  target.name,
                  renameText,
                  entries.map((x) => x.name),
                );
                if (!plan.ok) {
                  setRenameError(plan.reason);
                  return;
                }
                setRenameOf(null);
                void (async () => {
                  if (!bridge?.drive) return;
                  const made = await bridge.drive.rename(target.path, plan.name);
                  setNote(made ? `已重命名为 ${made}` : "重命名失败");
                  await refresh();
                })();
              }}
            >
              {RENAME_LABELS.ok}
            </button>
          </div>
        </div>
      ) : null}

      {menu ? (
        <DriveRowMenu
          onAiReading={(entry) => {
            setMenu(null);
            void (async () => {
              if (!bridge?.drive) return;
              if (!isTextKind(entry.kind)) {
                setNote(`「${entry.name}」不是文本，读不了`);
                return;
              }
              const text = await bridge.drive.read(entry.path);
              if (text === null) {
                setNote("读不出来（可能是空文件或太大了）");
                return;
              }
              useReaderStore.getState().open(text, entry.name);
              useWorkbenchStore.getState().setView("reader");
            })();
          }}
          onRename={(entry) => {
            setMenu(null);
            setRenameOf(entry);
            setRenameText(entry.name);
            setRenameError("");
          }}
          onDelete={(entry) => {
            setMenu(null);
            setConfirmDel(entry);
          }}
          onDownload={(entry) => {
            setMenu(null);
            void (async () => {
              if (!bridge?.drive) return;
              setNote(DOWNLOAD_LABELS.downloading);
              const got = await bridge.drive.download(entry.path);
              setNote(downloadNote(got));
            })();
          }}
          entry={menu.entry}
          x={menu.x}
          y={menu.y}
          starred={starred.has(menu.entry.name)}
          onClose={() => setMenu(null)}
          onChanged={(text) => {
            /*
             * 先刷新、再报回执 —— 顺序反过来会被 `refresh()` 结尾的 `setNote("")` 吃掉，
             * 用户看不到"已复制链接"这类确认（§208 那条验收逮到的）。
             */
            void (async () => {
              const ok = await refresh(true);
              if (ok) setNote(text);
            })();
          }}
        />
      ) : null}
    </section>
  );
}

/* ============================================================
 * 手机遥控电脑
 * ============================================================ */

