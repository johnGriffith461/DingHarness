import { useEffect, useState } from "react";
import type { ShellBridge } from "@shared/ipc";
import { WORKSPACE_LABELS, WORKSPACE_UNAUTHORIZED_HINT, addedNote, workspaceLabel } from "@shared/workspace";

/**
 * F-02（2026-10-20）：**设置里的工作目录管理**。
 *
 * ## 它兑现的是向导的一句承诺
 *
 * 首跑向导第 3 步写着"工作目录可以跳过，之后在设置里加"，而设置里根本没有这一格
 * （`SettingsPages.tsx` / `PersonalizePanel.tsx` 都 grep 不到工作目录）。入口只在
 * 输入区的「更多」弹层里 —— 用户按那句提示去找，一定找不到。
 *
 * ## 不重写对话框逻辑
 *
 * 添加走 `shell.workspace.add()`（主进程弹系统目录选择器，**不接受渲染进程传路径**）；
 * 移除走 `shell.workspace.remove()`。这两个 IPC 与输入区「更多」里那两颗按钮
 * 是同一份实现 —— 这里只负责列出来、给一颗按钮。
 */

/** 列表渲染用的行（纯函数：单测直接钉，不用起 DOM）。 */
export function workspaceRows(list: { dirs: string[] } | null | undefined): Array<{ dir: string; label: string }> {
  return (list?.dirs ?? []).map((dir) => ({ dir, label: workspaceLabel(dir) }));
}

/**
 * 「授权一个目录」之后的新状态。
 *
 * 用户取消选择时（`dir === null`）**不改列表、不写回执** —— 他什么都没做，
 * 不该看到一句"已授权"或"失败了"。
 */
export function afterWorkspaceAdd(
  current: { dirs: string[] },
  result: { dir: string | null; list: { dirs: string[] } } | undefined,
): { dirs: string[]; added: string | null; note: string } {
  if (!result) return { dirs: current.dirs, added: null, note: "目录选择器没有响应（数据通道不可用）" };
  if (!result.dir) return { dirs: result.list.dirs, added: null, note: "" };
  return { dirs: result.list.dirs, added: result.dir, note: addedNote(result.dir) };
}

/** 撤销一个目录之后的新状态（回执与输入区那侧同一句 `WORKSPACE_LABELS.removedNote`）。 */
export function afterWorkspaceRemove(
  current: { dirs: string[] },
  result: { dirs: string[] } | undefined,
): { dirs: string[]; note: string } {
  if (!result) return { dirs: current.dirs, note: "撤销没有生效（数据通道不可用）" };
  return { dirs: result.dirs, note: WORKSPACE_LABELS.removedNote };
}

export function WorkspaceSettings() {
  const [dirs, setDirs] = useState<string[] | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const shell = (globalThis as unknown as { shell?: ShellBridge }).shell;

  useEffect(() => {
    let alive = true;
    void shell?.workspace
      ?.list()
      .then((got) => {
        if (alive) setDirs(got?.dirs ?? []);
      })
      .catch(() => {
        if (alive) setDirs([]);
      });
    return () => {
      alive = false;
    };
  }, [shell]);

  const add = async (): Promise<void> => {
    if (busy || !shell?.workspace) return;
    setBusy(true);
    setNote("");
    try {
      const got = await shell.workspace.add();
      const next = afterWorkspaceAdd({ dirs: dirs ?? [] }, got);
      setDirs(next.dirs);
      setNote(next.note);
    } catch (error) {
      setNote(`打开目录选择器失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setBusy(false);
    }
  };

  const remove = async (dir: string): Promise<void> => {
    if (busy || !shell?.workspace) return;
    setBusy(true);
    setNote("");
    try {
      const got = await shell.workspace.remove(dir);
      const next = afterWorkspaceRemove({ dirs: dirs ?? [] }, got);
      setDirs(next.dirs);
      setNote(next.note);
    } catch (error) {
      setNote(`撤销失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="wb-workspace-settings" data-testid="wb-workspace-settings">
      <div className="wb-setpage-row">
        <span className="wb-setpage-label">工作目录</span>
        <button
          className="wb-setpage-btn"
          data-testid="wb-workspace-add"
          disabled={busy || !shell?.workspace}
          onClick={() => void add()}
        >
          ＋ 授权一个目录
        </button>
      </div>

      {dirs === null ? (
        <div className="wb-setpage-row">
          <em data-testid="wb-workspace-loading">正在读已授权的目录…</em>
        </div>
      ) : dirs.length === 0 ? (
        <div className="wb-setpage-row">
          <em data-testid="wb-workspace-empty">{WORKSPACE_LABELS.empty}</em>
        </div>
      ) : (
        workspaceRows({ dirs }).map((row) => (
          <div className="wb-setpage-row" key={row.dir} data-testid={`wb-workspace-row-${row.label}`}>
            <span className="wb-workspace-dir" title={row.dir}>
              {row.label}
            </span>
            <button
              className="wb-setpage-btn"
              data-testid={`wb-workspace-remove-${row.label}`}
              disabled={busy}
              onClick={() => void remove(row.dir)}
            >
              {WORKSPACE_LABELS.remove}
            </button>
          </div>
        ))
      )}

      {note ? (
        <div className="wb-setpage-hint" data-testid="wb-workspace-note">
          {note}
        </div>
      ) : null}
      <div className="wb-setpage-hint" data-testid="wb-workspace-hint">
        {WORKSPACE_UNAUTHORIZED_HINT}
      </div>
    </div>
  );
}
