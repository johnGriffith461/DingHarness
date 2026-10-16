import type { ShellBridge } from "@shared/ipc";
import { pickRoute } from "@shared/settings";

/**
 * 解析"这次请求该用哪个 provider/model"（§153 抽出来的共用件）。
 *
 * ## 为什么抽出来
 *
 * 原来这套回落逻辑只写在 `workbench/store.ts` 里（`resolveRoute`，私有）。
 * AI 文档的操作条要用同一个能力，如果照抄一份，就会出现
 * **同一台机器上"对话能用、润色说没通道"** 这种自相矛盾的现象 ——
 * 而那种错从现象上极难看出原因。
 *
 * ## 顺序
 *
 * ① 用户显式存过的设置（`dsh-canvas.chat-settings`）优先；
 * ② 没存过（或存的不可用）就**列一遍 provider，挑第一个能用的**；
 * ③ 都拿不到就返回空 —— 调用方给明确报错，而不是静默发一个空请求。
 */

const bridge = (): ShellBridge | undefined => (globalThis as unknown as { shell?: ShellBridge }).shell;

/** 用户显式存过的选择。 */
export function readSavedRoute(): { provider: string; model: string } {
  try {
    if (typeof localStorage === "undefined") return { provider: "", model: "" };
    const raw = localStorage.getItem("dsh-canvas.chat-settings");
    if (!raw) return { provider: "", model: "" };
    const parsed = JSON.parse(raw) as { provider?: string; model?: string };
    return { provider: parsed.provider ?? "", model: parsed.model ?? "" };
  } catch {
    return { provider: "", model: "" };
  }
}

/**
 * 解析路由。
 *
 * @returns `provider` 为空表示"没有可用通道"（调用方负责给用户看清原因）
 */
export async function resolveChatRoute(
  opts: { fresh?: boolean } = {},
): Promise<{ provider: string; model: string; fellBack?: boolean; pinned?: string }> {
  const saved = readSavedRoute();

  /*
   * 「新对话默认模型」（§183）：钉了默认且这是**新对话**就用它。
   *
   * ⚠️ 只在 `fresh` 时生效 —— 默认模型不该劫持一段正在进行的对话
   * （用户在那段里手动换过模型，再发一句又被拽回默认，很讨厌）。
   */
  const { pinnedModelNow } = await import("@/workbench/appSettings");
  /*
   * ⚠️ 必须把**真实的**可用列表传进去（§184）。
   *
   * §183 那版传的是空数组 —— 而 `pickRoute` 把"空数组"理解成
   * "没拿到可用信息，按还在处理"，于是**兜底分支永远不会触发**：
   * 逻辑写了、路没通。这里先列一次 provider，摊成 `provider/model` 再判断。
   */
  const pinned = pinnedModelNow();
  const available = await availableRoutes();
  const picked = pickRoute({
    pinned,
    last: saved,
    fresh: opts.fresh === true,
    available,
  });
  if (picked.source === "pinned") return { provider: picked.provider, model: picked.model };
  if (picked.source === "last") {
    return {
      provider: picked.provider,
      model: picked.model,
      ...(picked.fellBack ? { fellBack: true, pinned } : {}),
    };
  }

  if (saved.provider) return saved;
  try {
    const { listProviders } = await import("./aiClient");
    const providers = await listProviders();
    /*
     * ⚠️ 2026-10-16（审计 P254）：**必须排掉"可用但没有模型"的通道**。
     *
     * 原来只判 `p.available`，于是"provider 可用但 `models` 为空"（自定义中转、
     * 模型清单没配、或拉取失败）也会被选中 → 返回 `{provider, model:""}`。
     * 而调用方一律只判 `if (!provider)`（agentStore / docStore ×2 / taskRuntime），
     * 这条守卫直接被绕过：请求带着空 model 发出去，用户看到的是上游 400/502，
     * 手里却没有"该通道没有可选模型"这条线索 —— 排障方向被完全带偏。
     *
     * 这也正是本文件头第 ③ 条的承诺："都拿不到就返回空 —— 调用方给明确报错，
     * 而不是静默发一个空请求"。空 `models` 就属于"拿不到"。
     */
    const usable = providers.filter((p) => p.available && (p.models?.length ?? 0) > 0);
    const pick = usable.find((p) => p.verified) ?? usable[0];
    if (pick) return { provider: pick.id, model: pick.models[0] };
  } catch {
    /* 列不出来就让下面按空值走，主进程会给出明确报错 */
  }
  return saved;
}

/**
 * 现在可用的通道列表（`provider/model`）。
 *
 * 列不出来就给空数组 —— 调用方按"没拿到"处理（不误判失效）。
 *
 * @returns 可用的 `provider/model`
 */
async function availableRoutes(): Promise<string[]> {
  try {
    const { listProviders } = await import("./aiClient");
    const providers = await listProviders();
    return providers
      .filter((p) => p.available)
      .flatMap((p) => (p.models ?? []).map((m) => `${p.id}/${m}`));
  } catch {
    return [];
  }
}

/** 给用户看的"没有通道"说明（两处报错用同一句，免得口径分裂）。 */
export const NO_ROUTE_MESSAGE = "还没有可用的 AI 通道（先确认至少一个 provider 配好了密钥）";

// 供 docStore 用它的桥（避免两处各写一份 `globalThis.shell` 断言）
export { bridge };
