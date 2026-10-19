import type { HookName } from "../runtime/plugins";

/**
 * **插件钩子端口**（V5-4 任务 4.1）。
 *
 * 钩子要装载并执行**外部**代码（模组文件、子进程）—— 那是宿主的事，不是内核的事。
 * 内核只留这一个口子：`run(hook, payload)` 一次调用一个钩子，返回值不看
 * （只看不改，理由在 `runtime/registry.ts` 的调用处）。
 *
 * 不给 = **没有钩子**：这正是最小嵌入面（`ding-engine-core`）的形态 ——
 * 一轮真实回合不需要插件也能跑完，"没装插件"与"没接线"在这里是同一件事。
 * Node 侧要插件能力时注入 `runtime/pluginHost.ts` 的 `pluginHooks`。
 */
export type HookDecision =
  | { action: "allow" }
  | { action: "deny"; reason?: string }
  | { action: "modify"; input: unknown };

export type HooksPort = {
  /**
   * 执行一个钩子。
   *
   * `tool:before` 的返回值会被消费（allow/deny/modify）；其它钩子忽略返回值。
   * 宿主实现里的异常与超时由**内核**统一判成 deny（fail-closed）。
   */
  run: (hook: HookName, payload: unknown) => Promise<unknown>;
};

/** 没有钩子（默认）—— 用常量而不是 `undefined`，免得调用处到处 `?.`。 */
export const noopHooks: HooksPort = { run: async () => ({ action: "allow" }) };

/** 钩子超时（F5）：1 秒不返回就按 deny 处理，不给坏插件拖死一轮的机会。 */
export const HOOK_TIMEOUT_MS = 1000;

/**
 * 等一个钩子，超时返回 null（调用方按 fail-closed 处理）。
 * 抽出来是为了让"超时"与"抛错"走同一条判据，且能被单测。
 */
export async function runHookWithTimeout(
  hooks: HooksPort,
  hook: HookName,
  payload: unknown,
  timeoutMs = HOOK_TIMEOUT_MS,
): Promise<{ ok: true; value: unknown } | { ok: false; reason: string }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const value = await Promise.race([
      hooks.run(hook, payload),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`钩子 ${hook} 超时（${timeoutMs}ms）`)), timeoutMs);
      }),
    ]);
    return { ok: true, value };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  } finally {
    if (timer) clearTimeout(timer);
  }
}
