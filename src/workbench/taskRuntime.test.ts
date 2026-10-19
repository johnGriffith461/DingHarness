import { beforeEach, describe, expect, it } from "vitest";

import type { ChatRequest } from "@shared/ipc";
import type { ProjectContextResult } from "@shared/projectWire";
import { runStream } from "./taskRuntime";
import type { StorePort, WorkbenchState } from "./store";

/**
 * A1/A2 的接线：项目块必须真的进到 `ai.chat` 的 `system` 里。
 *
 * 这一条挡的是本项目最常见的伪实现形态：引擎里写了 `renderProjectContext`，
 * 但没人调用 —— 单测全绿，模型什么都没看到。
 */

function makePort(): StorePort {
  let state = { tasks: [], runningRequestId: null } as unknown as WorkbenchState;
  return {
    getState: () => state,
    setState: (partial: unknown) => {
      const patch = typeof partial === "function" ? (partial as (s: unknown) => unknown)(state) : partial;
      state = { ...state, ...(patch as object) } as WorkbenchState;
    },
    subscribe: () => () => undefined,
  } as unknown as StorePort;
}

function installBridge(projectRendered: string): { requests: ChatRequest[]; finish: () => void } {
  const requests: ChatRequest[] = [];
  const handlers: Array<(raw: unknown) => void> = [];
  let requestId = "";
  const project: ProjectContextResult = {
    context: {
      cwd: "C:\\work",
      rules: [],
      ruleText: "",
      platform: "win32",
      truncated: false,
    },
    rendered: projectRendered,
  };
  const bridge = {
    ai: {
      listProviders: async () => [
        { id: "strata", label: "S", models: ["m"], available: true, keyRef: "" },
      ],
      fetchModels: async () => ({ ok: true, models: [] }),
      probe: async () => [],
      chat: async (request: ChatRequest) => {
        requests.push(request);
        requestId = `req-${requests.length}`;
        return { ok: true, requestId };
      },
      abort: async () => undefined,
      onStream: (handler: (raw: unknown) => void) => {
        handlers.push(handler);
        return () => {
          const at = handlers.indexOf(handler);
          if (at >= 0) handlers.splice(at, 1);
        };
      },
    },
    project: {
      context: async () => project,
      reload: async () => project,
    },
    // resolveChatRoute 会读上次选择的模型
    memory: { read: async () => ({}), write: async () => ({}), clear: async () => ({}) },
  };
  (globalThis as unknown as { shell?: unknown }).shell = bridge;
  return {
    requests,
    finish: () => {
      for (const handler of [...handlers]) handler({ requestId, type: "done" });
    },
  };
}

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 200; i += 1) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`夹具没跑起来：${label}`);
}

beforeEach(() => {
  (globalThis as unknown as { shell?: unknown }).shell = undefined;
});

describe("A1/A2：项目上下文真的进了请求", () => {
  it("system 里包含项目块，且排在任务提示词之前", async () => {
    const fake = installBridge("<project_instructions>\n规则：pnpm test\n</project_instructions>\n\n<environment>\ncwd: C:\\work\n</environment>");
    const port = makePort();

    const turn = runStream(port, "修一下失败测试", "你是一个任务助手。", () => undefined, [], "task-1");
    await waitFor(() => fake.requests.length === 1, "第一轮请求");
    fake.finish();
    await turn;

    expect(fake.requests).toHaveLength(1);
    const system = String(fake.requests[0].system ?? "");
    expect(system).toContain("<project_instructions>");
    expect(system).toContain("规则：pnpm test");
    expect(system).toContain("<environment>");
    expect(system.indexOf("<project_instructions>")).toBeGreaterThan(-1);
    /*
     * 顺序按 `assembleSystem`：base（任务要求）→ persona → **project** → memory。
     * 项目块不是压过任务要求，而是紧跟身份之后、先于记忆。
     */
    expect(system.indexOf("<project_instructions>")).toBeGreaterThan(system.indexOf("你是一个任务助手"));
  });

  it("项目块为空时不产生空标题", async () => {
    const fake = installBridge("");
    const port = makePort();

    const turn = runStream(port, "你好", "你是任务助手", () => undefined, [], "task-2");
    await waitFor(() => fake.requests.length === 1, "第一轮请求");
    fake.finish();
    await turn;

    const system = String(fake.requests[0].system ?? "");
    expect(system).toBe("你是任务助手");
    expect(system).not.toContain("<project_instructions>");
  });

  it("读取失败不阻塞本轮（仍发出请求）", async () => {
    const fake = installBridge("");
    const shell = (globalThis as unknown as { shell: { project: unknown } }).shell;
    shell.project = {
      context: async () => {
        throw new Error("读不到");
      },
      reload: async () => {
        throw new Error("读不到");
      },
    };
    const port = makePort();

    const turn = runStream(port, "你好", "系统", () => undefined, [], "task-3");
    await waitFor(() => fake.requests.length === 1, "失败路径的请求");
    fake.finish();
    await turn;

    expect(fake.requests).toHaveLength(1);
    expect(String(fake.requests[0].system)).toBe("系统");
  });
});
