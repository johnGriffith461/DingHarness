import { ipcMain } from "electron";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  clearProjectContextCache,
  loadProjectContext,
  renderProjectContext,
} from "../../engine/runtime/projectContext";
import {
  listWorkspaceDir,
  readWorkspaceFile,
  searchWorkspaceEntries,
} from "../../engine/runtime/workspaceFiles";
import { buildRepoMap } from "../../engine/runtime/repoMap";
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
  mentions: "project:mentions",
  listDir: "project:listDir",
  readFile: "project:readFile",
  writeAgents: "project:writeAgents",
  repoMap: "project:repoMap",
} as const;

/** 全局规则目录：用户把跨项目约定放这里（`~/.ding/AGENTS.md`）。 */
function globalRuleDir(): string {
  return path.join(os.homedir(), ".ding");
}

function projectRoot(): string {
  const dirs = workspaceDirsSync();
  return dirs[0] ?? process.cwd();
}

/*
 * 地图缓存（E1）：全仓扫描 ~2s（1271 文件实测 1.95s）。首轮与 `/map` 会各调一次，
 * 60 秒内复用同一份；过期后重算（不做 fs.watch：平台差异大，且地图本来就是"看一眼"）。
 */
let mapCache: { root: string; at: number; maxTokens: number; value: Awaited<ReturnType<typeof buildRepoMap>> } | null = null;

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
  ipc.handle(PROJECT_CHANNEL.mentions, async (_event, query: unknown) => {
    if (typeof query !== "string") return [];
    return await searchWorkspaceEntries(projectRoot(), query);
  });
  ipc.handle(PROJECT_CHANNEL.listDir, async (_event, dir: unknown) => {
    if (typeof dir !== "string" || !dir.trim()) return [];
    return await listWorkspaceDir(projectRoot(), dir);
  });
  ipc.handle(PROJECT_CHANNEL.readFile, async (_event, file: unknown) => {
    if (typeof file !== "string" || !file.trim()) return { ok: false as const, error: "没有给路径" };
    return await readWorkspaceFile(projectRoot(), file);
  });
  ipc.handle(PROJECT_CHANNEL.repoMap, async (_event, opts: unknown) => {
    const maxTokens =
      opts && typeof opts === "object" && typeof (opts as { maxTokens?: unknown }).maxTokens === "number"
        ? Math.max(64, (opts as { maxTokens: number }).maxTokens)
        : undefined;
    const root = projectRoot();
    const budget = maxTokens ?? 1024;
    if (mapCache && mapCache.root === root && mapCache.maxTokens === budget && Date.now() - mapCache.at < 60_000) {
      return mapCache.value;
    }
    const value = await buildRepoMap(root, { maxTokens: budget });
    mapCache = { root, at: Date.now(), maxTokens: budget, value };
    return value;
  });
  ipc.handle(PROJECT_CHANNEL.writeAgents, async (_event, content: unknown) => {
    if (typeof content !== "string" || !content.trim()) return { ok: false as const, error: "内容为空" };
    const file = path.join(projectRoot(), "AGENTS.md");
    try {
      await fs.writeFile(file, content, "utf8");
      clearProjectContextCache();
      return { ok: true as const, path: file };
    } catch (error) {
      return { ok: false as const, error: error instanceof Error ? error.message : String(error) };
    }
  });
}
