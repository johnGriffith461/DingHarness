import { createInterface } from "node:readline";

import { AcpAgent } from "../acp/agent";
import { startAgentServer } from "../server/agentServer";
import { normalizeConfirmMode, type ConfirmMode } from "../../shared/ipc";
import { flag, flagAll, type Parsed } from "./args";
import { buildEngine } from "./assembly";
import { effectiveConfig } from "./config";

/**
 * `ding serve` / `ding acp` —— 随处可用（Phase 17）。
 *
 * ## 两条口径都写在命令自己身上（而不是藏在文档里）
 *
 * · `serve`：**默认只绑回环**。要对外必须同时给 `--bind` 与 `--token` ——
 *   起服务之前会硬拒（见 `agentServer.ts` 的说明：agent 能读写文件、跑命令，
 *   一个没认证的公开服务等于把这些交给整个网络）。
 * · `acp`：走标准输入输出，**agent 作为外部客户端的子进程**。
 *   于是**日志绝不能写 stdout** —— 那是协议通道（写进去会污染 JSON-RPC 流）。
 */

/** 这一段宿主侧共用的装配（两个命令一样）。 */
function hostDeps(dataDir: string) {
  const { config } = effectiveConfig(dataDir);
  const dirs = config.dirs ?? [process.cwd()];
  return {
    provider: config.provider ?? "",
    ...(config.model ? { model: config.model } : {}),
    mode: normalizeConfirmMode(flag({ command: "", args: [], flags: new Map() }, "mode") ?? config.mode ?? "按需确认") as ConfirmMode,
    makeEngine: async (cwd: string) => {
      /*
       * 工作目录用**客户端给的那个**（ACP/HTTP 都会带 cwd），但只在**已授权目录**里取 ——
       * 外部宿主不该因为能连上就获得新的可写范围。
       */
      const allowed = dirs.filter((d) => cwd.startsWith(d));
      const use = allowed.length ? [cwd] : dirs;
      return buildEngine(use, dataDir);
    },
    dirs,
  };
}

/** `ding serve [--port 8787] [--bind 0.0.0.0 --token xxx] [--hook name=prompt]`。 */
export async function cmdServe(p: Parsed, dataDir: string): Promise<number> {
  const deps = hostDeps(dataDir);
  const port = Number(flag(p, "port") ?? 8787);
  const bind = flag(p, "bind");
  const token = flag(p, "token");
  const hooks: Record<string, string> = {};
  for (const spec of flagAll(p, "hook")) {
    const at = spec.indexOf("=");
    if (at > 0) hooks[spec.slice(0, at).trim()] = spec.slice(at + 1).trim();
  }

  if (!deps.provider) {
    process.stderr.write("先配一个 provider：ding init（或 ding config set provider <id>）\n");
    return 3;
  }

  let started;
  try {
    started = await startAgentServer({
      port,
      ...(bind ? { bind } : {}),
      ...(token ? { token } : {}),
      makeEngine: deps.makeEngine,
      mode: deps.mode,
      provider: deps.provider,
      ...(deps.model ? { model: deps.model } : {}),
      cwd: deps.dirs[0] ?? process.cwd(),
      hooks,
      log: (line) => process.stderr.write(`[serve] ${line}\n`),
    });
  } catch (error) {
    // 硬拒（比如"对外绑定没给 token"）在这里变成一句人话 + 非零退出
    process.stderr.write(`${(error as Error)?.message ?? error}\n`);
    return 2;
  }

  process.stdout.write(
    [
      `Agent Server 已起：${started.url}`,
      `  档位：${deps.mode}　provider：${deps.provider}`,
      `  接口：GET /healthz　GET /v1/info　POST /v1/run（SSE）${Object.keys(hooks).length ? `　POST /v1/hooks/<名字>（${Object.keys(hooks).join(" / ")}）` : ""}`,
      `  ${bind && bind !== "127.0.0.1" ? "⚠️ 绑在非回环地址上：token 是唯一的一道门，别把它贴到聊天里" : "只绑回环（本机可用；对外请显式 --bind 并同时给 --token）"}`,
      "",
      "Ctrl+C 退出。",
      "",
    ].join("\n"),
  );

  /* 等到被杀：这个进程的存在本身就是服务 */
  return await new Promise<number>((resolve) => {
    const stop = () => {
      started.server.close(() => resolve(0));
    };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
  });
}

/** `ding acp` —— 作为 ACP agent 跑在标准输入输出上。 */
export async function cmdAcp(p: Parsed, dataDir: string): Promise<number> {
  const deps = hostDeps(dataDir);
  if (!deps.provider) {
    process.stderr.write("先配一个 provider：ding init（或 ding config set provider <id>）\n");
    return 3;
  }

  const agent = new AcpAgent({
    makeEngine: deps.makeEngine,
    mode: deps.mode,
    provider: deps.provider,
    ...(deps.model ? { model: deps.model } : {}),
    /* ⚠️ 协议通道是 **stdout**：只写 JSON-RPC 一行一条，别的都去 stderr */
    send: (message) => process.stdout.write(JSON.stringify(message) + "\n"),
    log: (line) => process.stderr.write(`[acp] ${line}\n`),
  });

  const rl = createInterface({ input: process.stdin, terminal: false });
  for await (const line of rl) {
    await agent.handleLine(line);
  }
  void p;
  return 0;
}
