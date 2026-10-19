import { app, ipcMain, shell } from "electron";
import path from "node:path";

import {
  MCP_LABELS,
  emptyMcpConfig,
  mcpToolName,
  normalizeMcpConfig,
  serverStatusLine,
  transportOf,
  type McpConfig,
  type McpServerConfig,
} from "../../shared/mcp";
import { createJsonStore } from "./jsonStore";
import { HttpMcpClient, McpClient, type McpCallResult, type McpConnection, type McpStatus } from "./mcpClient";

/**
 * 连接器（MCP server）的配置、生命周期与工具暴露（2026-10-14）。
 *
 * ## 为什么是"配置文件 + 界面看状态"这种形态
 *
 * 参考实现的形态：opencode / goose / cline 都支持 MCP，用户侧的动作都是**写一份配置**
 * （opencode 的 `mcp` 段、goose 的 extensions、cline 的 MCP Servers 面板）。
 * 我们这里给的是**最诚实也最够用**的一版：
 *   · 配置是 `mcp.json`（C1 信封），界面上能**看见**每个连接器的状态与工具数；
 *   · 「打开配置文件」直接开系统编辑器、「重新连接」重连 —— 这两件事都是真的。
 * 之所以不做"在界面里填命令/参数"的表单：那需要一整套输入校验 + 编辑体验，
 * 而**当前价值最高的是"能连上、能用"**，不是表单好不好看（主人原话：先做功能）。
 *
 * ## 三条硬规矩
 * ① **连不上不许把应用拖垮**：启动时**不阻塞**建窗口，每个 server 各自成败；
 * ② **工具名带前缀**：`mcp__<server>__<tool>`，闸门据此按"外部工具"对待（见 `shared/permissions.ts`）；
 * ③ **退出时要收尸**：`stopAllMcp()` 把子进程全杀掉，不留孤儿。
 */

export const MCP_CHANNEL = {
  list: "mcp:list",
  reload: "mcp:reload",
  openConfig: "mcp:openConfig",
  /* F1：资源 / 提示词 */
  resources: "mcp:resources",
  readResource: "mcp:readResource",
  prompts: "mcp:prompts",
  getPrompt: "mcp:getPrompt",
} as const;

const FILE = "mcp.json";

function filePath(): string {
  return path.join(app.getPath("userData"), FILE);
}

const store = createJsonStore<McpConfig>({
  file: filePath,
  initial: () => emptyMcpConfig(),
  normalize: (value) => normalizeMcpConfig(value),
});

/** 配置（内存一份；启动时读、reload 时更新）。 */
let config: McpConfig = emptyMcpConfig();

/** 正在跑的连接（按 server 名）。两种传输共用一个形状（`McpConnection`）。 */
const clients = new Map<string, McpConnection>();

/** 一个连接器给界面看的样子。 */
export type McpServerView = {
  name: string;
  /** stdio 的命令（HTTP 传输时为空串）。 */
  command: string;
  /** HTTP 端点（stdio 传输时为空串）。U04 加了它，界面才能说清"这是怎么连的"。 */
  url: string;
  args: string[];
  enabled: boolean;
  status: McpStatus;
  /** 状态那一句话（已连接 · 提供 N 个工具 / 连接失败 …） */
  line: string;
  /** 连不上时的原因（界面要显示它，不能一片空白） */
  error: string;
  tools: Array<{ localName: string; name: string; description: string }>;
};

/** 读配置（不连接）。 */
export async function loadMcpConfig(): Promise<McpConfig> {
  const got = await store.read();
  if (got.foreign) console.error("[mcp] 磁盘上的连接器配置读不动（保留原样）：", got.note);
  config = got.data;
  return config;
}

/**
 * 启动时把该连的都连上。
 *
 * ⚠️ **不 await 完再建窗口**：一个 MCP server 起不来（命令写错、依赖没装）
 * 不该让用户看不到界面。所以这里是"尽力而为"，失败只记状态。
 */
export async function startAllMcp(): Promise<void> {
  await loadMcpConfig();
  /*
   * 非文本内容的落点（U04）：`<userData>/mcp-attachments`。
   * 与工具结果落盘（`tool-results/`）分开：一个是"连接器给回来的附件"，
   * 一个是"我们截断下来的完整输出"，混在一起会让 TTL 清理互相误伤。
   */
  const attachmentsDir = path.join(app.getPath("userData"), "mcp-attachments");
  await Promise.all(
    config.servers.map(async (server) => {
      if (server.enabled === false) return;
      const client =
        transportOf(server) === "http"
          ? new HttpMcpClient(server, undefined, { attachmentsDir })
          : new McpClient(server, undefined, { attachmentsDir });
      clients.set(server.name, client);
      const ok = await client.start();
      console.log(`[mcp] ${server.name}：${ok ? `已连接（${client.toolList().length} 个工具）` : `连接失败（${client.errorText()}）`}`);
    }),
  );
}

/**
 * 重新连接（用户点了「重新连接」，或配置改完）。
 *
 * ⭐ **重入保护**（2026-10-16，审计 P40）：原来是 `stopAllMcp(); await startAllMcp();`
 * 直接排开。两次快速重载（连点两下按钮、或"改完配置自动重连"与手点同时发生）时：
 * 第二轮 `clients.set(name, client)` 会把**还在 `await client.start()` 的第一轮那个
 * client 对象**从台账里换掉 —— 它已经 spawn 了子进程，却再也不在 `clients` 里，
 * `stopAllMcp()` 永远收不到它，那个 `node <server>` 就成了孤儿（还占着管道）。
 *
 * 做法：整段重载排在一条队列上（后到的等前一次做完），并且**每次重载先收尸**。
 * 队列只保留"完成"这个事实，一次失败不堵住后面的人。
 */
let reloadChain: Promise<unknown> = Promise.resolve();

export function reloadMcp(): Promise<McpServerView[]> {
  const run = reloadChain.then(
    async () => {
      stopAllMcp();
      await startAllMcp();
      return mcpServerViews();
    },
    async () => {
      stopAllMcp();
      await startAllMcp();
      return mcpServerViews();
    },
  );
  reloadChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/** 收尸。 */
export function stopAllMcp(): void {
  for (const client of clients.values()) client.stop();
  clients.clear();
}

/**
 * 现在该交给模型的 MCP 工具（扁平表）。
 *
 * @returns 每个连接器当前可用的工具，带本机名字与 schema
 */
export function mcpToolBindings(): Array<{
  localName: string;
  server: string;
  tool: string;
  description: string;
  inputSchema: unknown;
}> {
  const out: ReturnType<typeof mcpToolBindings> = [];
  for (const server of config.servers) {
    const client = clients.get(server.name);
    if (!client || client.status() !== "on") continue;
    for (const t of client.toolList()) {
      out.push({
        localName: mcpToolName(server.name, t.name),
        server: server.name,
        tool: t.name,
        description: (t.description ?? "").trim() || `连接器「${server.name}」提供的工具 ${t.name}`,
        inputSchema: t.inputSchema,
      });
    }
  }
  return out;
}

/** 调一个连接器工具（本机名 → server + 原始名）。 */
export async function callMcpTool(localName: string, args: unknown): Promise<McpCallResult> {
  const binding = mcpToolBindings().find((b) => b.localName === localName);
  if (!binding) return { ok: false, error: "这个连接器工具现在不可用（连接断了或者已经被移除）" };
  const client = clients.get(binding.server);
  if (!client) return { ok: false, error: "连接器没在跑" };
  return await client.call(binding.tool, args);
}

/** 给界面用的视图。 */
export function mcpServerViews(): McpServerView[] {
  return config.servers.map((server: McpServerConfig) => {
    const client = clients.get(server.name);
    const status: McpStatus = client ? client.status() : server.enabled === false ? "off" : "error";
    const tools = client
      ? client.toolList().map((t) => ({
          localName: mcpToolName(server.name, t.name),
          name: t.name,
          description: (t.description ?? "").trim(),
        }))
      : [];
    return {
      name: server.name,
      command: server.command ?? "",
      url: server.url ?? "",
      args: server.args ?? [],
      enabled: server.enabled !== false,
      status,
      line: serverStatusLine(server, status === "on" ? "on" : status === "off" ? "off" : status === "starting" ? "starting" : "error", tools.length),
      error: client && status !== "on" ? client.errorText() : "",
      tools,
    };
  });
}

/** 配置文件不存在时先落一份空的（带注释不行，JSON 不支持 —— 所以放一句说明在界面里）。 */
async function ensureConfigFile(): Promise<void> {
  const current = await store.read();
  if (current.foreign) return;
  if (current.data.servers.length === 0 && !current.migrated) {
    const exists = await import("node:fs/promises")
      .then((fs) => fs.access(filePath()).then(() => true).catch(() => false));
    if (!exists) await store.write(emptyMcpConfig());
  }
}

/** 注册 IPC。 */
/**
 * F1：把所有**在线**连接器的资源/提示词汇总出来（带 server 名）。
 * 服务端不声明这些能力时就是空数组 —— 界面据此显示"该 server 未声明"。
 */
export async function listMcpResources(): Promise<Array<{ server: string; uri: string; name: string; mimeType?: string; description?: string }>> {
  const out: Array<{ server: string; uri: string; name: string; mimeType?: string; description?: string }> = [];
  for (const server of config.servers) {
    const client = clients.get(server.name);
    if (!client || client.status() !== "on" || !client.listResources) continue;
    for (const item of await client.listResources()) out.push({ server: server.name, ...item });
  }
  return out;
}

export async function readMcpResource(server: string, uri: string): Promise<Array<{ uri: string; mimeType?: string; text: string }>> {
  const client = clients.get(server);
  if (!client || client.status() !== "on" || !client.readResource) return [];
  return await client.readResource(uri);
}

export async function listMcpPrompts(): Promise<Array<{ server: string; name: string; description?: string; arguments?: Array<{ name: string; description?: string; required?: boolean }> }>> {
  const out: Array<{ server: string; name: string; description?: string; arguments?: Array<{ name: string; description?: string; required?: boolean }> }> = [];
  for (const server of config.servers) {
    const client = clients.get(server.name);
    if (!client || client.status() !== "on" || !client.listPrompts) continue;
    for (const item of await client.listPrompts()) out.push({ server: server.name, ...item });
  }
  return out;
}

export async function getMcpPrompt(
  server: string,
  name: string,
  args?: Record<string, string>,
): Promise<Array<{ role: string; text: string }>> {
  const client = clients.get(server);
  if (!client || client.status() !== "on" || !client.getPrompt) return [];
  return await client.getPrompt(name, args);
}

export function registerMcpIpc(): () => void {
  ipcMain.handle(MCP_CHANNEL.list, async () => {
    await ensureConfigFile();
    return { file: filePath(), servers: mcpServerViews(), empty: MCP_LABELS.empty };
  });
  ipcMain.handle(MCP_CHANNEL.reload, async () => reloadMcp());
  ipcMain.handle(MCP_CHANNEL.resources, async () => listMcpResources());
  ipcMain.handle(MCP_CHANNEL.readResource, async (_e, server: unknown, uri: unknown) => {
    if (typeof server !== "string" || typeof uri !== "string") return [];
    return await readMcpResource(server, uri);
  });
  ipcMain.handle(MCP_CHANNEL.prompts, async () => listMcpPrompts());
  ipcMain.handle(MCP_CHANNEL.getPrompt, async (_e, server: unknown, name: unknown, args: unknown) => {
    if (typeof server !== "string" || typeof name !== "string") return [];
    return await getMcpPrompt(server, name, args && typeof args === "object" ? (args as Record<string, string>) : undefined);
  });
  ipcMain.handle(MCP_CHANNEL.openConfig, async () => {
    await ensureConfigFile();
    const res = await shell.openPath(filePath());
    return { ok: !res, error: res };
  });
  return () => {
    for (const ch of Object.values(MCP_CHANNEL)) ipcMain.removeHandler(ch);
  };
}
