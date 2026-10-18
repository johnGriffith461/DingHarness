/**
 * **插件隔离进程**（G18）：插件代码在 Worker 里跑，不在主进程。
 *
 * ## 它解决什么
 *
 * v1 的插件与应用**同进程、同权限**：插件里 `while(true){}` 能卡死整个应用，
 * 一个未捕获异常能带崩主进程，`fs`/`child_process` 想干什么就干什么。
 * 这一版把插件搬进 **worker_threads**：
 *
 * | 能力 | 现在 |
 * |---|---|
 * | 卡死主进程 | ❌ 不再 —— 超时就 `terminate()`，主线程不受影响 |
 * | 未捕获异常带崩应用 | ❌ 不再 —— worker 自己死，主进程收到错误 |
 * | 读插件目录之外的文件 | ✅ 默认拒绝（Node 权限模型；见下） |
 * | 写文件 / 起子进程 | ✅ 默认拒绝；声明了 `fs:write` / `exec` 并在安装时批准才开 |
 * | 联网 | ⚠️ **仍不拦**（Node 权限模型没有网络那一格）—— 如实记 |
 *
 * ## Node 权限模型不是万能的
 *
 * `--permission` 在 Node 20+ 可用；不同版本支持的格子不同。所以启动时**先试带
 * 权限参数的 worker**，起不来（老 Node / Electron 不支持）就退到普通 worker，
 * 并把 `isolation` 标成 `"worker"` 而不是 `"worker-permission"` —— 界面与文档
 * 据此如实说"隔离了崩溃，但文件/命令边界没有强制"。
 *
 * ## 为什么用内联源码 + `eval: true`
 *
 * 宿主有两条编译路（vitest 的 ESM 与桌面的 CJS），`new Worker(new URL(...))` 在
 * 其中一条上会解析错路径；`__dirname` 在另一条上不存在。把 worker 源码作为字符串
 * 传进去，两条路都不依赖文件位置 —— 而这段代码本来就只有几十行。
 */

import { realpathSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";


/** 插件在 worker 里能用的东西（宿主侧形状）。 */
export type IsolatedPlugin = {
  /** 装了哪种隔离（如实给界面看）。 */
  isolation: "worker-permission" | "worker";
  /** 插件导出的工具名 → 描述与参数 schema（只读元数据）。 */
  tools: Record<string, { description?: string; inputSchema?: unknown }>;
  /** 插件导出的钩子名。 */
  hooks: string[];
  /** 调一个工具（超时由调用方给）。 */
  run: (tool: string, input: unknown, timeoutMs: number) => Promise<unknown>;
  /** 跑一个钩子（返回值忽略）。 */
  hook: (name: string, payload: unknown, timeoutMs: number) => Promise<void>;
  /** 关掉 worker（装载重来/应用退出时调）。 */
  close: () => void;
};

/** 启动结果。 */
export type IsolatedStart =
  | { ok: true; plugin: IsolatedPlugin }
  | { ok: false; error: string };

/**
 * worker 里跑的那段（自包含：只用 `node:worker_threads` 和动态 import）。
 *
 * 协议：
 *   worker → host：`{type:"ready", tools:[{name, description?, inputSchema?}], hooks:[...]}`
 *   host → worker：`{id, kind:"tool"|"hook", name, input?, payload?}`
 *   worker → host：`{id, ok, value?}` / `{id, ok:false, error}`；加载失败 `{type:"fatal", error}`
 */
const WORKER_SOURCE = `
const { parentPort, workerData } = require("node:worker_threads");
(async () => {
  let mod;
  try {
    mod = await import(workerData.entryUrl);
  } catch (error) {
    parentPort.postMessage({ type: "fatal", error: String(error && error.message ? error.message : error) });
    return;
  }
  const toolNames = Object.keys((mod && mod.tools) || {});
  const tools = toolNames.map((name) => {
    const def = mod.tools[name] || {};
    return {
      name,
      ...(typeof def.description === "string" ? { description: def.description } : {}),
      ...(def.inputSchema && typeof def.inputSchema === "object" ? { inputSchema: def.inputSchema } : {}),
    };
  });
  parentPort.postMessage({ type: "ready", tools, hooks: Object.keys((mod && mod.hooks) || {}) });
  parentPort.on("message", async (msg) => {
    const reply = (payload) => parentPort.postMessage(Object.assign({ id: msg && msg.id }, payload));
    try {
      if (!msg || typeof msg !== "object") return reply({ ok: false, error: "请求形状不对" });
      if (msg.kind === "tool") {
        const def = mod && mod.tools && mod.tools[msg.name];
        if (!def || typeof def.run !== "function") throw new Error("插件没有这个工具：" + msg.name);
        const value = await def.run(msg.input, msg.ctx || {});
        reply({ ok: true, value: value === undefined ? null : value });
        return;
      }
      if (msg.kind === "hook") {
        const fn = mod && mod.hooks && mod.hooks[msg.name];
        if (typeof fn !== "function") throw new Error("插件没有这个钩子：" + msg.name);
        await fn(msg.payload);
        reply({ ok: true, value: null });
        return;
      }
      reply({ ok: false, error: "不认识的请求类型" });
    } catch (error) {
      reply({ ok: false, error: String(error && error.message ? error.message : error) });
    }
  });
})();
`;

type Pending = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

/** 起一个隔离插件（先试权限模式，失败再退普通 worker）。 */
export function startIsolatedPlugin(input: {
  dir: string;
  entryUrl: string;
  /** 批准了 `fs:write` 才允许写（写范围只给插件目录）。 */
  allowWrite: boolean;
  /** 批准了 `exec` 才允许起子进程。 */
  allowExec: boolean;
  /** 元数据握手超时（默认 10 秒）。 */
  describeTimeoutMs?: number;
}): Promise<IsolatedStart> {
  return startWith(input, true);
}

function startWith(
  input: { dir: string; entryUrl: string; allowWrite: boolean; allowExec: boolean; describeTimeoutMs?: number },
  tryPermission: boolean,
): Promise<IsolatedStart> {
  return new Promise((resolve) => {
    /*
     * ⚠️ **权限模型的允许路径必须用 realpath —— 入口 URL 也一样**（2026-10-18 macOS 真机）。
     *
     * 权限模型按**解析后的真实路径**比对。macOS 的临时目录 `/var/folders/…`
     * 实际指向 `/private/var/folders/…`（`/var` 是符号链接），于是：
     *   · `--allow-fs-read=/var/…` 是一条"看起来对、比对时对不上"的路；
     *   · 而 `import("file:///var/…")` 里的路径也是那条符号链接路。
     * 两边各自"看起来一致"，但在权限模型眼里一个在允许集合里、一个不在 ——
     * 插件一加载就报 `Access to this API has been restricted`。
     * Windows 上路径没有符号链接，所以同一份代码一直是好的。
     *
     * 修法：**两侧都换成 realpath**（允许集合 + 入口 URL），平台差异就消失了。
     * （实测：只换允许集合不够；mac 上跑 `probe2` 四种组合里只有"入口也用 realpath"
     * 那一组能过。）
     */
    const realDir = (() => {
      try {
        return realpathSync(input.dir);
      } catch {
        return input.dir;
      }
    })();
    const realEntryUrl = (() => {
      try {
        if (!input.entryUrl.startsWith("file:")) return input.entryUrl;
        const asPath = fileURLToPath(input.entryUrl.replace(/\?.*$/, ""));
        return pathToFileURL(realpathSync(asPath)).href;
      } catch {
        return input.entryUrl;
      }
    })();
    const execArgv = tryPermission
      ? [
          "--permission",
          /*
           * 允许集合把**两条路都给**：调用方给的目录 + 它的 realpath（去重）。
           *
           * 只给 realpath 不够：插件拿到的路径仍是调用方那一条（macOS 上是 `/var/…`），
           * 它写 `./inside.txt` 时权限模型看到的是**未解析**的子路径 —— 只认 realpath
           * 的允许集合会把"明明在目录里"的写入拒掉（真机测试「已批准 fs:write
           * 只能写插件目录」那条就是这么红的）。两条都给才不误伤同一种目录的两种写法。
           */
          ...[...new Set([input.dir, realDir])].map((dir) => `--allow-fs-read=${dir}`),
          ...(input.allowWrite ? [...new Set([input.dir, realDir])].map((dir) => `--allow-fs-write=${dir}`) : []),
          ...(input.allowExec ? ["--allow-child-process"] : []),
        ]
      : [];
    /* 只允许一次结论：error 与 exit 可能先后都来（fallback 只能起一次） */
    let settled = false;
    const finish = (value: IsolatedStart): void => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    let worker: Worker;
    try {
      worker = new Worker(WORKER_SOURCE, {
        eval: true,
        workerData: { entryUrl: realEntryUrl },
        ...(execArgv.length ? { execArgv } : {}),
        /* 资源上限：内存（128MB）与栈（4MB）—— 超了 worker 自己被干掉，主进程不陪葬 */
        resourceLimits: { maxOldGenerationSizeMb: 128, stackSizeMb: 4 },
      });
    } catch (error) {
      if (tryPermission) {
        void startWith(input, false).then(finish);
        return;
      }
      finish({ ok: false, error: `起不了隔离进程：${String((error as Error)?.message ?? error)}` });
      return;
    }

    const pending = new Map<number, Pending>();
    let nextId = 1;
    let ready = false;
    let closed = false;

    const failAll = (error: Error): void => {
      for (const [id, entry] of pending) {
        clearTimeout(entry.timer);
        entry.reject(error);
        pending.delete(id);
      }
    };

    const timer = setTimeout(() => {
      if (ready) return;
      closed = true;
      void worker.terminate();
      finish({ ok: false, error: `插件 ${input.dir} 在 ${Math.round((input.describeTimeoutMs ?? 10_000) / 1000)} 秒内没有加载完成` });
    }, input.describeTimeoutMs ?? 10_000);

    worker.on("message", (msg: unknown) => {
      const m = msg as { type?: string; id?: number; ok?: boolean; value?: unknown; error?: string; tools?: unknown; hooks?: unknown };
      if (m?.type === "ready") {
        ready = true;
        clearTimeout(timer);
        const tools: IsolatedPlugin["tools"] = {};
        for (const raw of Array.isArray(m.tools) ? m.tools : []) {
          const t = raw as { name?: unknown; description?: unknown; inputSchema?: unknown };
          if (typeof t?.name !== "string") continue;
          tools[t.name] = {
            ...(typeof t.description === "string" ? { description: t.description } : {}),
            ...(t.inputSchema && typeof t.inputSchema === "object" ? { inputSchema: t.inputSchema } : {}),
          };
        }
        const hooks = (Array.isArray(m.hooks) ? m.hooks : []).filter((h): h is string => typeof h === "string");

        const call = (payload: Record<string, unknown>, timeoutMs: number): Promise<unknown> =>
          new Promise((ok, no) => {
            if (closed) {
              no(new Error("插件进程已经结束了"));
              return;
            }
            const id = nextId++;
            const t = setTimeout(() => {
              pending.delete(id);
              /* 超时 = 这个插件卡住了：**终止整个 worker**，不让它继续吃 CPU */
              closed = true;
              failAll(new Error("插件进程因超时被终止"));
              void worker.terminate();
              no(new Error(`插件工具 ${Math.round(timeoutMs / 1000)} 秒没有返回，已终止它的进程`));
            }, timeoutMs);
            pending.set(id, { resolve: ok, reject: no, timer: t });
            worker.postMessage({ id, ...payload });
          });

        finish({
          ok: true,
          plugin: {
            isolation: execArgv.length ? "worker-permission" : "worker",
            tools,
            hooks,
            run: (tool, value, timeoutMs) => call({ kind: "tool", name: tool, input: value, ctx: {} }, timeoutMs),
            hook: async (name, payload, timeoutMs) => {
              await call({ kind: "hook", name, payload }, timeoutMs);
            },
            close: () => {
              closed = true;
              failAll(new Error("插件进程已关闭"));
              void worker.terminate();
            },
          },
        });
        return;
      }
      if (m?.type === "fatal") {
        clearTimeout(timer);
        closed = true;
        void worker.terminate();
        finish({ ok: false, error: m.error ?? "插件加载失败" });
        return;
      }
      const id = typeof m?.id === "number" ? m.id : -1;
      const entry = pending.get(id);
      if (!entry) return;
      pending.delete(id);
      clearTimeout(entry.timer);
      if (m.ok) entry.resolve(m.value);
      else entry.reject(new Error(m.error ?? "插件调用失败"));
    });

    worker.on("error", (error) => {
      clearTimeout(timer);
      failAll(error instanceof Error ? error : new Error(String(error)));
      if (!ready) {
        closed = true;
        void worker.terminate();
        if (tryPermission) {
          /* 权限参数这个版本不认 —— 退普通 worker 再试一次（隔离仍然成立） */
          void startWith(input, false).then(finish);
        } else {
          finish({ ok: false, error: `插件进程出错：${String((error as Error)?.message ?? error)}` });
        }
      }
    });

    worker.on("exit", (code) => {
      clearTimeout(timer);
      failAll(new Error(`插件进程退出了（code ${code}）`));
      if (!ready) {
        closed = true;
        if (tryPermission) void startWith(input, false).then(finish);
        else finish({ ok: false, error: `插件进程退出（code ${code}）` });
      }
    });
  });
}
