import { ipcMain } from "electron";
import os from "node:os";
import path from "node:path";

import {
  clearProjectContextCache,
  loadProjectContext,
  renderProjectContext,
} from "../../engine/runtime/projectContext";
import type { ProjectContextResult } from "../../shared/projectWire";
import { workspaceDirsSync } from "./workspaceStore";

/**
 * 项目上下文的 IPC（A1/A2）。
 *
 * ## 为什么由主进程读
 *
 * 渲染进程没有真实的 `process.cwd()`，也不该拿到任意读文件的权限。主进程知道
 * "用户授权了哪个工作区"（`workspaceDirsSync()`），读规则、探测包管理器、
 * 渲染成块，一并交给渲染层。
 *
 * ## 选哪个目录
 *
 * 第一个授权工作区；一个都没授权时回落到 `process.cwd()`（开发期从仓库根启动，
 * 正好就是项目根）。这不是"猜"——设置页会把 `cwd` 原样显示出来，用户看得见。
 */

export const PROJECT_CHANNEL = {
  context: "project:context",
  reload: "project:reload",
} as const;

/** 全局规则目录：用户把跨项目约定放这里（`~/.ding/AGENTS.md`）。 */
function globalRuleDir(): string {
  return path.join(os.homedir(), ".ding");
}

function projectRoot(): string {
  const dirs = workspaceDirsSync();
  return dirs[0] ?? process.cwd();
}

function read(): ProjectContextResult {
  const ctx = loadProjectContext(projectRoot(), { globalDir: globalRuleDir() });
  return { context: ctx, rendered: renderProjectContext(ctx) };
}

export function registerProjectIpc(ipc: Pick<typeof ipcMain, "handle">): void {
  ipc.handle(PROJECT_CHANNEL.context, () => read());
  ipc.handle(PROJECT_CHANNEL.reload, () => {
    clearProjectContextCache();
    return read();
  });
}
