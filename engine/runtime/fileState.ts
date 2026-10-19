/**
 * 读后写校验的**会话级**状态（D3）。
 *
 * 键是 `sessionId + 绝对路径`，值是读那一刻的 `{mtimeMs, size}`。
 * 放模块级是刻意的：这段状态要跨"同一会话的多轮工具调用"活着；
 * 用 sessionId 隔离，两段对话读同一个文件互不污染。
 *
 * 边界：进程内有效（重启后第一次编辑没有读记录 → 不做 stale 判定）。
 * 这与"必须先 read_file 再 edit_file"的提示词纪律一致，不会误伤老会话。
 */

export type FileFingerprint = { mtimeMs: number; size: number };

const reads = new Map<string, FileFingerprint>();

function keyOf(sessionId: string, file: string): string {
  return `${sessionId}\u0000${file.toLowerCase()}`;
}

export function noteRead(sessionId: string | undefined, file: string, fingerprint: FileFingerprint): void {
  if (!sessionId) return;
  reads.set(keyOf(sessionId, file), fingerprint);
}

export function expectedFingerprint(sessionId: string | undefined, file: string): FileFingerprint | undefined {
  if (!sessionId) return undefined;
  return reads.get(keyOf(sessionId, file));
}

/** 编辑成功后更新指纹（同一轮里连续两次改同一文件不该被自己判 stale）。 */
export function noteWrite(sessionId: string | undefined, file: string, fingerprint: FileFingerprint): void {
  noteRead(sessionId, file, fingerprint);
}

/** 测试/会话结束时清。 */
export function clearFileState(sessionId?: string): void {
  if (!sessionId) {
    reads.clear();
    return;
  }
  const prefix = `${sessionId}\u0000`;
  for (const key of [...reads.keys()]) if (key.startsWith(prefix)) reads.delete(key);
}
