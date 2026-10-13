import { app, ipcMain } from "electron";
import fs from "node:fs";
import path from "node:path";

import { normalizeAgentFile, type AgentFile } from "../../shared/agent";

/**
 * 本机 AI 智能体的落盘（§156）。
 *
 * 与 `docStore` / `readerStore` 同一个形态：userData 下一个 json + 两个 IPC，
 * 读回时过 `normalizeAgents`（磁盘不可信）。
 *
 * ⚠️ 本体的智能体在**云端**（有头像生成、有封禁策略、能发现别人的）。
 * 本机版只存这一份本地数据 —— 那些能力**不做**，见 `shared/agent.ts` 的说明。
 */

export const AGENT_CHANNEL = {
  load: "agent:load",
  save: "agent:save",
} as const;

const FILE = "agents.json";

function filePath(): string {
  return path.join(app.getPath("userData"), FILE);
}

/** 读回本机智能体（含"当前选中的"）。 */
export function loadAgents(): AgentFile {
  try {
    return normalizeAgentFile(JSON.parse(fs.readFileSync(filePath(), "utf8")));
  } catch {
    return { agents: [], selected: "" };
  }
}

/**
 * 写回（临时文件 + rename）。
 *
 * @param next 任意值（会被规整）
 * @returns 规整之后真正落盘的内容
 */
export function saveAgents(next: unknown): AgentFile {
  const file = normalizeAgentFile(next);
  fs.mkdirSync(path.dirname(filePath()), { recursive: true });
  const tmp = `${filePath()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(file, null, 2), "utf8");
  fs.renameSync(tmp, filePath());
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
