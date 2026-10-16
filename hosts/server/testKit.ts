import { rmSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { request as httpRequest } from "node:http";

import { CwdNotAllowedError } from "../cwd";
import { startAgentServer, type ServerOptions } from "./agentServer";

/**
 * **Agent Server 的测试装置**（从 `agentServer.test.ts` 里提出来的一份共用件）。
 *
 * 拆它的直接原因：测试文件涨到 1100 行，撞了"巨石守卫"（`.ts` ≤ 900，测试也在扫描范围里）。
 * 拆的口径是"这一块谁都在用"——假引擎、起服务、发请求、收 SSE，
 * 与"这一组在验什么"无关。
 *
 * ## 假引擎
 *
 * `makeEngine` 是注入的假对象：跑一轮立即返回（或者挂起直到 abort）。
 * 于是服务器那几组测的是**协议与安全口径**，毫秒级、不需要任何 key。
 */

export type FakeBehaviour = {
  /** 跑一轮挂起，直到 abortSignal 触发（用来测取消通道与关闭路径）。 */
  hang?: boolean;
  /** 这些 cwd 一律拒绝（模拟真实宿主里的 `CwdNotAllowedError`）。 */
  rejectCwd?: string[];
};

export function fakeEngineFactory(behaviour: FakeBehaviour = {}) {
  const opened: string[] = [];
  const messages: string[] = [];
  const sessionIds: (string | undefined)[] = [];
  /**
   * 每一轮的 `ownerActor.id`（C1）—— **已有会话不换主**那条断言要看它。
   *
   * ⚠️ 记的是 id 字符串不是整个 actor：断言要的是"归谁"，不是"什么种类"。
   */
  const ownerActors: (string | undefined)[] = [];
  /** 每一轮传下来的成员角色（C2 人轴）—— `undefined` = 没传（判定层按 owner 兜底）。 */
  const memberRoles: (readonly string[] | undefined)[] = [];
  let aborted = 0;
  return {
    opened,
    messages,
    sessionIds,
    ownerActors,
    memberRoles,
    get aborted() {
      return aborted;
    },
    makeEngine: async (cwd: string) => {
      if (behaviour.rejectCwd?.includes(cwd)) throw new CwdNotAllowedError(`工作目录不在授权范围内：${cwd}`);
      opened.push(cwd);
      return {
        engine: {
          async run(request: {
            messages: { content: string }[];
            sessionId?: string;
            ownerActor?: { id: string };
            memberRoles?: readonly string[];
            onEvent?: (e: unknown) => void;
            abortSignal?: AbortSignal;
          }) {
            messages.push(request.messages[0]!.content);
            sessionIds.push(request.sessionId);
            ownerActors.push(request.ownerActor?.id);
            memberRoles.push(request.memberRoles);
            if (behaviour.hang) {
              return await new Promise((resolve) => {
                const done = () => {
                  aborted += 1;
                  resolve({ ok: false, aborted: true, events: [], records: [], requestId: "r1", provider: "fake", model: "fake" });
                };
                if (request.abortSignal?.aborted) done();
                else request.abortSignal?.addEventListener("abort", done, { once: true });
              });
            }
            request.onEvent?.({ type: "text", text: "你好" });
            return { ok: true, aborted: false, events: [], records: [], requestId: "r1", provider: "fake", model: "fake" };
          },
          async resume() {
            return { turns: [], pending: [] };
          },
          tools: {},
        },
        close: () => undefined,
      };
    },
  } as never as {
    opened: string[];
    messages: string[];
    sessionIds: (string | undefined)[];
    ownerActors: (string | undefined)[];
    memberRoles: (readonly string[] | undefined)[];
    readonly aborted: number;
    makeEngine: (cwd: string) => Promise<{ engine: never; close: () => void }>;
  };
}

/**
 * 起过的服务统一在结算时 `stop()`。
 *
 * keep-alive 连接（`node:http` 的全局 agent 默认开着）会拖住普通的
 * `server.close()` —— 它要等所有连接结束，而连接要等客户端；测试进程
 * 因此会挂住。`stop()` 会销毁在途连接，也正是产品里那条关闭路径，
 * 顺带每次都被这批测试走到。
 */
export const running: Array<() => Promise<void>> = [];
/** 空间账本/临时数据目录（用完删 —— Windows 上尽力而为）。 */
export const cleanupDirs: string[] = [];

/** 结算：停掉所有起过的服务、清掉临时目录。测试文件的 `afterEach` 调它。 */
export async function stopEverything(): Promise<void> {
  for (const stop of running.splice(0)) await stop();
  for (const dir of cleanupDirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    } catch {
      /* 尽力而为 */
    }
  }
}

/** 起一个服务并拿它的地址（端口给 0 = 系统分配）。 */
export async function boot(over: Partial<ServerOptions> = {}, behaviour: FakeBehaviour = {}) {
  const fake = fakeEngineFactory(behaviour);
  const logs: string[] = [];
  const started = await startAgentServer({
    port: 0,
    makeEngine: fake.makeEngine as never,
    mode: "按需确认",
    provider: "fake",
    cwd: process.cwd(),
    log: (line) => logs.push(line),
    ...over,
  });
  running.push(started.stop);
  return { ...started, fake, logs };
}

/**
 * 发一条请求。
 *
 * 用 `node:http` 而不是 `fetch`：这几条断言要的就是"能自己控制 Host / Origin /
 * Sec-Fetch 这类头"，而 fetch 对这些头有它自己的想法。
 */
export function call(
  port: number,
  path: string,
  init: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: "127.0.0.1", port, path, method: init.method ?? "GET", headers: init.headers ?? {} },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => (text += chunk));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, text }));
      },
    );
    req.on("error", reject);
    if (init.body) req.write(init.body);
    req.end();
  });
}

/** 收一整段 SSE（`/v1/run` 那种真流）。 */
export function collectSse(port: number, path: string, body: string, headers: Record<string, string>): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: "127.0.0.1", port, path, method: "POST", headers }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => (text += chunk));
      res.on("end", () => resolve(text));
    });
    req.on("error", reject);
    req.end(body);
  });
}

/** 给别的模块用的类型再导出（省得再 import 一次 agentServer 的类型）。 */
export type { IncomingMessage, ServerResponse };
