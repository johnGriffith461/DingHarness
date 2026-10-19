import { useEffect, useState } from "react";

import type { ShellBridge } from "@shared/ipc";
import { ConfirmDialog, type ConfirmRequest } from "./ConfirmDialog";

/**
 * **确认框的宿主**（2026-10-19）：把主进程发来的确认请求画成应用内的框。
 *
 * ## 为什么要有它
 *
 * CUA 的授权与每次动作确认原来走 `dialog.showMessageBox` —— 系统原生窗口。
 * 主人看到的第一反应是"这弹窗是啥狗屎啊，太硬核了"。它确实有三个真问题：
 * 样式与产品脱节、截图验收拿不到（不在 DOM 里）、抢焦点。
 *
 * 现在：主进程通过 `computer:confirmRequest` 发请求，这个组件画框，
 * 用户点完把答案经 `computer:confirmAnswer` 送回去。
 *
 * ## 挂在哪
 *
 * 挂在 `Workbench` 根上（应用级），因为触发方可能是任意面板里的动作。
 * 同一时刻只显示一个（主进程那边也只保留一个待答）。
 */
export function ConfirmHost() {
  const [request, setRequest] = useState<{ id: string; req: ConfirmRequest } | null>(null);

  useEffect(() => {
    const shell = (globalThis as unknown as { shell?: ShellBridge }).shell;
    if (!shell?.computer?.onConfirmRequest) return;
    return shell.computer.onConfirmRequest((incoming) => {
      setRequest({
        id: incoming.id,
        req: {
          title: incoming.title,
          message: incoming.message,
          ...(incoming.detail === undefined ? {} : { detail: incoming.detail }),
          confirmLabel: incoming.confirmLabel,
          ...(incoming.danger === undefined ? {} : { danger: incoming.danger }),
        },
      });
    });
  }, []);

  if (!request) return null;

  const answer = async (ok: boolean) => {
    const shell = (globalThis as unknown as { shell?: ShellBridge }).shell;
    setRequest(null);
    await shell?.computer.confirmAnswer({ id: request.id, ok });
  };

  return <ConfirmDialog request={request.req} onAnswer={(ok) => void answer(ok)} />;
}
