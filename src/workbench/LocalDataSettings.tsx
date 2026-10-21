import { useEffect, useState } from "react";

import type { ShellBridge } from "@shared/ipc";

import { ConfirmDialog, type ConfirmRequest } from "./ConfirmDialog";

/**
 * 设置 → 通用 →「本机数据」（M-08）。
 *
 * 主人报的第 6 条要的是"设置里能看到数据路径并能清空，干净装机后任务中心为空"。
 * 这里显示**主进程给的真实路径**（不是渲染层猜的），清空前把数字说清：
 * 会话 / 任务 / 授权目录各多少；**密钥不在清空范围**（在 `~/.ding` / `secrets.dat`）。
 */

type Summary = { dataDir: string; sessions: number; tasks: number; workspaces: number };

export function LocalDataSettings() {
  const shell = (globalThis as unknown as { shell?: ShellBridge }).shell;
  const [dir, setDir] = useState("");
  const [note, setNote] = useState("");
  const [pending, setPending] = useState<null | { request: ConfirmRequest; summary: Summary }>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    void shell?.localData
      ?.summary()
      .then((got) => {
        if (alive) setDir(got.dataDir);
      })
      .catch(() => {
        void shell?.userDataDir?.().then((value) => alive && setDir(value)).catch(() => undefined);
      });
    return () => {
      alive = false;
    };
  }, [shell]);

  const ask = async (): Promise<void> => {
    if (!shell?.localData) {
      setNote("清空要在本应用里用（浏览器预览没有 IPC）");
      return;
    }
    try {
      const summary = await shell.localData.summary();
      setPending({
        summary,
        request: {
          title: "清空本机数据？",
          message: `会删 ${summary.sessions} 个会话、${summary.tasks} 条任务、${summary.workspaces} 个授权目录。`,
          detail: "还会清掉本机的模型启用状态与设置；密钥不在其中（在 ~/.ding）。不可撤销，清完应用会重启一次。",
          confirmLabel: "清空并重启",
          danger: true,
        },
      });
    } catch (error) {
      setNote(`读不到数据目录：${error instanceof Error ? error.message : String(error)}`);
    }
  };

  return (
    <div className="wb-setpage-row" data-testid="wb-localdata">
      <span className="wb-setpage-label">本机数据</span>
      <em data-testid="wb-localdata-path" title={dir} className="wb-locadata-path">
        {dir || "（读不到）"}
      </em>
      <button className="wb-setpage-btn" data-testid="wb-localdata-clear" disabled={busy} onClick={() => void ask()}>
        {busy ? "清理中…" : "清空本机数据"}
      </button>
      {note ? (
        <div className="wb-card-note" data-testid="wb-localdata-note">
          {note}
        </div>
      ) : null}

      {pending ? (
        <ConfirmDialog
          request={pending.request}
          onAnswer={(ok) => {
            setPending(null);
            if (!ok) return;
            setBusy(true);
            void shell?.localData
              ?.reset()
              .then((res) => {
                setNote(res.ok ? "正在重启并清空…" : res.reason ?? "没能安排清理");
                if (res.ok) setBusy(false);
              })
              .catch((error) => {
                setBusy(false);
                setNote(`没能安排清理：${error instanceof Error ? error.message : String(error)}`);
              });
          }}
        />
      ) : null}
    </div>
  );
}
