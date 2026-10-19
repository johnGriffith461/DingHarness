import { app, ipcMain } from "electron";
import fs from "node:fs/promises";
import path from "node:path";

import { normalizeLspConfig, type LspConfig, type LspDiagnostic } from "../../engine/runtime/lsp";
import {
  lspNoteForEdits as runLspNoteForEdits,
  lspStatusOf,
  stopAllLsp as stopLspProcesses,
} from "../../engine/runtime/lspClient";

/**
 * LSP 宿主（G6）：读 `lsp.json` + 暴露设置页用的状态。
 *
 * 真正的进程收发在 `engine/runtime/lspClient.ts`（不 import electron，
 * 所以假 LSP server 能在 vitest 里跑端到端）。这一层只做两件事：
 * 决定配置从哪读、把状态喂给界面。
 */

export const LSP_CHANNEL = {
  list: "lsp:list",
  reload: "lsp:reload",
} as const;

export function lspConfigPath(): string {
  return path.join(app.getPath("userData"), "lsp.json");
}

let config: LspConfig = { servers: [] };
let loaded = false;

/** 读 `lsp.json`（缺文件 = 没有服务器；坏文件 = 空配置 + 日志）。 */
export async function loadLspConfig(): Promise<LspConfig> {
  try {
    const text = await fs.readFile(lspConfigPath(), "utf8");
    config = normalizeLspConfig(JSON.parse(text) as unknown);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      console.error("[lsp] 配置读不动（按未配置处理）：", error instanceof Error ? error.message : error);
    }
    config = { servers: [] };
  }
  loaded = true;
  return config;
}

/**
 * 有没有配置任何 LSP 服务器（编辑路径据此决定要不要读"编辑前"文本）。
 * 没配置时连文件都不读 —— 不拿"以后可能有用"当借口给每次编辑加一次磁盘往返。
 */
export async function lspActive(): Promise<boolean> {
  if (!loaded) await loadLspConfig();
  return config.enabled !== false && config.servers.length > 0;
}

/**
 * 编辑后的诊断（只报新增 error）。没配置时零成本返回空串。
 *
 * @param edits 每个文件：绝对路径 + **编辑前**的文本（新建文件传 null）
 */
export async function lspNoteForEdits(
  edits: Array<{ path: string; before: string | null }>,
): Promise<{ line: string; errors: LspDiagnostic[] }> {
  if (!loaded) await loadLspConfig();
  return await runLspNoteForEdits(config, edits);
}

/** 设置页/诊断用：配置里的服务器与当前状态。 */
export async function lspServerViews(): Promise<{
  file: string;
  enabled: boolean;
  servers: ReturnType<typeof lspStatusOf>;
}> {
  if (!loaded) await loadLspConfig();
  return {
    file: lspConfigPath(),
    enabled: config.enabled !== false,
    servers: lspStatusOf(config),
  };
}

export function stopAllLsp(): void {
  stopLspProcesses();
}

export function registerLspIpc(ipc: Pick<typeof ipcMain, "handle" | "removeHandler">): () => void {
  ipc.handle(LSP_CHANNEL.list, async () => lspServerViews());
  ipc.handle(LSP_CHANNEL.reload, async () => {
    stopLspProcesses();
    loaded = false;
    await loadLspConfig();
    return await lspServerViews();
  });
  return () => {
    for (const channel of Object.values(LSP_CHANNEL)) ipc.removeHandler(channel);
  };
}
