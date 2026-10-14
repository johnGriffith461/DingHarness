import { artifactFileName, extractArtifacts } from "@/workbench/artifact";
import type { ChatMessageRecord } from "./chatStore";
import { nextId } from "./ids";
import { splitTurns, type LogRecord } from "@engine/core/events";
import type { ShellBridge } from "@shared/ipc";

/** 正文与工具行之间的分隔（恢复时把两者拼回一段正文）。 */
const NS = "\n\n";

/**
 * 把一段会话日志投影成聊天的消息（F3）。
 *
 * ## 为什么由日志恢复
 *
 * 日志里已经有"发生过什么"的全部：用户说了什么（在 `request` 里）、
 * 模型回了什么（`text`）、它调了什么工具、**用户批过还是拒过**、真实用量。
 * 于是恢复不需要另存一份消息数组（那会是第二处真相，而且一定会漂移）。
 *
 * ## 三个细节
 *
 * 1. **一条 request 对应"一句用户话 + 一条回复"** —— 与发送时的形状一致。
 * 2. **正文要过 `extractArtifacts`**：日志里存的是**原始输出**（含 `<artifact>` 标签），
 *    而界面上该显示的是干净正文 + 卡片（§186）。所以恢复时重做一次提取，
 *    并按文件名到产物目录里**认回**路径（`listArtifacts`）—— **不重写文件**：
 *    用户可能已经改过那个文件，重写会盖掉他的改动。
 * 3. **被拦下未处置的留痕照旧带出来**（`pending`），用户重启之后仍然能批 ——
 *    这正是 §176 为工作台修过的同一件事，聊天侧现在也有了。
 *
 * @param records 会话日志
 * @returns 消息列表（旧 → 新）
 */
export function messagesFromRecords(records: readonly LogRecord[]): ChatMessageRecord[] {
  const out: ChatMessageRecord[] = [];
  for (const chunk of splitTurns(records)) {
    const request = chunk.request;
    const user = [...(request?.messages ?? [])].reverse().find((m) => m.role === "user");
    if (user?.content) {
      out.push({
        id: nextId("m"),
        role: "user",
        content: user.content,
        status: "done",
        createdAt: request?.at ?? Date.now(),
      });
    }
    const view = chunk.view;
    if (!view.text && !view.traces.length && !view.error) continue;
    /*
     * 正文 = 模型说的话 + **每一条工具留痕那一行**。
     *
     * ⚠️ 为什么要带上工具行：实时那条路径把工具行**写进正文**（`content: ... + line`），
     * 只把"还在等确认"的那些另外挂成可点的留痕。恢复时若不带上，
     * 用户会看到"这句话产出了什么"整段消失 —— 尤其是**批过之后**那种：
     * 它的留痕已经不再是 `pending`，不会出现在按钮列表里。
     *
     * ⚠️ 与实时路径的**一处差异**（如实记着）：实时那一行是"当时的措辞"
     * （等确认时写「等你确认（还没执行）」），而恢复拿到的是**最终结论**
     * （「已保存，当前 1 条」）。恢复后的更接近事实，所以不去人为还原成旧措辞。
     */
    const body = [view.text, ...view.traces.map((t) => t.line)].filter(Boolean).join(NS);
    const extracted = body
      ? extractArtifacts(body, `chat-restored-${chunk.request?.requestId ?? "x"}`, Date.now(), (i) => `m-${out.length}-a${i + 1}`)
      : { text: "", artifacts: [] };
    out.push({
      id: nextId("m"),
      role: "assistant",
      content: extracted.text,
      status: view.error ? "error" : "done",
      createdAt: request?.at ?? Date.now(),
      ...(request?.model ? { model: request.model } : {}),
      ...(view.usage ? { usage: view.usage } : {}),
      ...(view.error ? { error: view.error } : {}),
      ...(view.traces.some((t) => t.pending) ? { tools: view.traces.filter((t) => t.pending) } : {}),
      ...(extracted.artifacts.length ? { artifacts: extracted.artifacts } : {}),
    });
  }
  return out;
}

/** 取 preload 桥（与 `chatStore.ts` 里同一套取法）。 */
const shellBridge = (): ShellBridge | undefined =>
  (globalThis as unknown as { shell?: ShellBridge }).shell;

/** 从产物目录里认回产物卡的文件路径与字节数（**只读**：不重写文件）。 */
export async function attachArtifactPaths(messages: ChatMessageRecord[]): Promise<ChatMessageRecord[]> {
  const shell = shellBridge();
  if (!shell?.workbench?.listArtifacts) return messages;
  const files = await shell.workbench.listArtifacts().catch(() => []);
  if (!files.length) return messages;
  const byName = new Map(files.map((f) => [f.name, f]));
  return messages.map((m) => {
    if (!m.artifacts?.length) return m;
    return {
      ...m,
      artifacts: m.artifacts.map((a) => {
        const hit = byName.get(artifactFileName(a));
        return hit
          ? { ...a, status: "generated" as const, filePath: hit.filePath, bytes: hit.bytes }
          : { ...a, status: "generated" as const };
      }),
    };
  });
}
