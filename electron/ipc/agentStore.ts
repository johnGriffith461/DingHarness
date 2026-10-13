import { app, ipcMain } from "electron";
import path from "node:path";

import { normalizeAgentFile, type AgentFile } from "../../shared/agent";
import { createJsonStore } from "./jsonStore";

/**
 * 本机 AI 智能体的落盘（§156）。
 *
 * 与 `docStore` / `readerStore` 同一个形态：userData 下一个 json + 两个 IPC，
 * 读回时过 `normalizeAgents`（磁盘不可信）。
 *
 * ⚠️ 本体的智能体在**云端**（有头像生成、有封禁策略、能发现别人的）。
 * 本机版只存这一份本地数据 —— 那些能力**不做**，见 `shared/agent.ts` 的说明。
 *
 * ── C1（2026-10-13）：落盘收进 `./jsonStore` ──
 *
 * 那手"临时文件 + rename"现在由 `./jsonStore` 统一提供，并且**多两条保证**：
 * 写失败重试 3 次（Windows 上"文件被占用"大多是一次性冲突，不重试就是丢数据），
 * 以及信封带版本 —— 以后智能体的形状真变了，才有地方挂迁移。
 *
 * ⚠️ 磁盘上现存的 `agents.json` 是**裸数据**（更早的版本还存过裸数组，
 * `normalizeAgentFile` 里那句"兼容旧文件"就是为它写的）—— 它会被读成"版本 0"并原样迁上来。
 * 这一条是硬要求：读不出来就等于把用户建过的智能体全清空。
 */

export const AGENT_CHANNEL = {
  load: "agent:load",
  save: "agent:save",
} as const;

const FILE = "agents.json";

function filePath(): string {
  return path.join(app.getPath("userData"), FILE);
}

/** 落盘器（C1：原子写 + 重试 + 信封版本，全部在 `./jsonStore` 里一份）。 */
const store = createJsonStore<AgentFile>({
  file: filePath,
  initial: () => normalizeAgentFile(null),
  normalize: (value) => normalizeAgentFile(value),
});

/** 读回本机智能体（含"当前选中的"）。 */
export async function loadAgents(): Promise<AgentFile> {
  const got = await store.read();
  // 读不动（磁盘上是更新的版本）只报一声：这里给的是空库兜底值，界面照常起得来
  if (got.foreign) console.error("[agent] 磁盘上的智能体读不动（保留原样）：", got.note);
  return got.data;
}

/**
 * 写回（原子写由 `./jsonStore` 负责）。
 *
 * ⚠️ 磁盘上是**更新的版本**时**拒绝覆盖**（`foreign`）：那是降级运行（装过新版本又换回旧版本），
 * 硬写回去等于把用户的智能体降级销毁 —— 同 §178.6 / §179.6 / §181.6 的取舍：宁可这次没存上。
 *
 * @param next 任意值（会被规整）
 * @returns 规整之后真正落盘的内容
 */
export async function saveAgents(next: unknown): Promise<AgentFile> {
  const file = normalizeAgentFile(next);

  const current = await store.read();
  if (current.foreign) {
    console.error("[agent] 磁盘上的智能体版本比本程序新，已拒绝覆盖：", current.note);
    return file;
  }

  const res = await store.write(file);
  if (!res.ok) {
    // 原来写失败是一条日志都没有的，用户只会发现"重启后智能体没了"
    console.error("[agent] 落盘失败（重试过）：", res.error);
  }
  return file;
}

/**
 * 注册相关 IPC。
 *
 * @returns 解除注册的函数
 */
export function registerAgentIpc(): () => void {
  ipcMain.handle(AGENT_CHANNEL.load, () => loadAgents());
  ipcMain.handle(AGENT_CHANNEL.save, (_event, next: unknown) => saveAgents(next));
  return () => {
    for (const ch of Object.values(AGENT_CHANNEL)) ipcMain.removeHandler(ch);
  };
}
