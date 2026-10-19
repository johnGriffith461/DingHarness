import { app, ipcMain } from "electron";
import path from "node:path";

import { readAttachmentDataUrl, saveAttachment } from "../../engine/runtime/attachments";
import type { AttachmentSaveResult } from "../../shared/ipc";

/**
 * 附件落盘 IPC（B3）。
 *
 * 渲染层拿到的是 `File` 的 base64；主进程只负责写到**会话私有目录**并回报
 * 路径/大小/sha256。文件名不用用户给的（`saveAttachment` 里用 uuid），
 * 所以 `../../x.png` 这类名字逃不出附件目录。
 */

export const ATTACHMENT_CHANNEL = {
  save: "attachments:save",
  readAsDataUrl: "attachments:readAsDataUrl",
} as const;

function sessionsDir(): string {
  return path.join(app.getPath("userData"), "sessions");
}

export function registerAttachmentIpc(ipc: Pick<typeof ipcMain, "handle">): void {
  ipc.handle(
    ATTACHMENT_CHANNEL.save,
    async (
      _event,
      input: { sessionId?: unknown; name?: unknown; mediaType?: unknown; data?: unknown },
    ): Promise<AttachmentSaveResult> => {
      if (typeof input?.sessionId !== "string" || !input.sessionId.trim()) {
        return { ok: false, error: "没有给会话 id" };
      }
      if (typeof input.name !== "string" || typeof input.mediaType !== "string" || typeof input.data !== "string") {
        return { ok: false, error: "附件参数不完整" };
      }
      return await saveAttachment(sessionsDir(), {
        sessionId: input.sessionId,
        name: input.name,
        mediaType: input.mediaType,
        data: input.data,
      });
    },
  );
  /* G2：重启后按需读回（只允许会话目录内；越界/被清理都返回可读错误）。 */
  ipc.handle(ATTACHMENT_CHANNEL.readAsDataUrl, async (_event, file: unknown) => {
    if (typeof file !== "string" || !file.trim()) return { ok: false as const, error: "没有给附件路径" };
    return await readAttachmentDataUrl(sessionsDir(), file);
  });
}
