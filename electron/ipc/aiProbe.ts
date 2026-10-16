import path from "node:path";
import { app } from "electron";
import type { ProviderInfo } from "../../shared/ipc";
import { modelIdsFromJson, modelsUrlFor } from "../../engine/runtime/modelsFetch";
import { resolveSecret } from "../../engine/runtime/credentials";
import { allProviders, getProvider, listProviders } from "../../engine/runtime/providers";
import { blockedReason, fetchRemote, realModelBlocked } from "../../engine/runtime/modelGate";
import { createJsonStore } from "./jsonStore";
import type { HealthStore } from "../../engine/ports/health";

/**
 * provider 可用性探测。
 *
 * 背景（实测踩到的信任问题）：`listProviders()` 里的 `available` 只表示
 * **有没有配置密钥**。但"有密钥"不等于"真能调用" —— 本机实测 apihub 域名不可达、
 * 通义千问返回 400 Access denied、本地 provider 没起服务，界面却全显示为"可用"。
 * 用户点下去才发现用不了，这是很差的体验。
 *
 * 所以这里把"可用"拆成两级，并且**只有真的探测成功过才升级为"已验证"**：
 *   · available=true, verified=false → 有密钥，但这次会话还没成功调用过
 *   · available=true, verified=true  → 本会话真的成功调过一次
 *
 * 探测结果落在 userData 下的一个小文件里（跨启动保留），并在每次真实调用成功时刷新。
 * 探测本身只在用户显式触发时跑（`probeProviders`），不在启动时批量打网络请求 ——
 * 那会拖慢启动、还会白烧额度。
 */

/** 一条探测记录。 */
type ProbeEntry = { verifiedAt: string; ok: boolean; note?: string };

/** 全部探测记录（provider id → 结论）。 */
type ProbeRecord = Record<string, ProbeEntry>;

function probeFile(): string {
  return path.join(app.getPath("userData"), "provider-probe.json");
}

/**
 * 收窄从磁盘读回来的探测记录（**磁盘不可信** —— C1 的规矩）。
 *
 * 这个文件原来是**裸 `JSON.parse` 加一句 `as ProbeRecord`**：一个手改过的文件
 * （或者被别的程序写坏）就能让 `listProvidersWithProbe` 里的 `probe?.ok` 抛异常，
 * 于**整个 provider 列表拉不出来** —— 用户看到的是"AI 全挂了"。
 *
 * @param raw 磁盘上的值
 * @returns 干净记录（坏条目直接丢）
 */
export function normalizeProbes(raw: unknown): ProbeRecord {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: ProbeRecord = {};
  for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!value || typeof value !== "object") continue;
    const v = value as Record<string, unknown>;
    if (typeof v.verifiedAt !== "string" || typeof v.ok !== "boolean") continue;
    out[id] = {
      verifiedAt: v.verifiedAt,
      ok: v.ok,
      ...(typeof v.note === "string" && v.note ? { note: v.note } : {}),
    };
  }
  return out;
}

/*
 * ── C1 收编（2026-10-13 补完）────────────────────────────────────
 *
 * 这个文件原来是**手写落盘**，是全仓唯一被明牌列在 C1 结构守卫例外里的第二处
 * （另一处是画布快照）。当时没动它的理由是：读路径是**同步**的，改异步会让
 * "读-改-写"交错 —— 而 `markProviderOk` / `markProviderFailed` 是**即发即忘**地写同一个文件。
 *
 * 现在两件一起做掉，那条理由就不成立了：
 * 1. 落盘走 `createJsonStore`（原子写 + 重试 + 信封版本）；
 * 2. 读-改-写**串行化**（下面的 `chain`）—— 并发调用排队执行，不会互相覆盖。
 *
 * 于是 `provider-probe.json` 与其余 12 个 json 落盘走同一条路，守卫里那条例外可以撤掉。
 */
const store = createJsonStore<ProbeRecord>({
  file: probeFile,
  initial: () => ({}),
  normalize: (value) => normalizeProbes(value),
});

/** 读-改-写的串行队列（并发写会丢条目：甲读到 {}、乙也读到 {}，两者各写一份）。 */
let chain: Promise<void> = Promise.resolve();

/**
 * 串行地改一次探测记录。
 *
 * ⚠️ 磁盘上是**更新的版本**（`foreign`）时**不写**：那是降级运行，硬写回去等于把
 * 用户的东西降级销毁 —— 与其余 12 个落盘同一条取舍。
 *
 * @param mutate 把当前记录变成新记录
 */
function update(mutate: (current: ProbeRecord) => ProbeRecord): void {
  chain = chain
    .then(async () => {
      const got = await store.read();
      if (got.foreign) {
        console.error("[probe] 磁盘上的探测记录版本比本程序新，已拒绝覆盖：", got.note);
        return;
      }
      const res = await store.write(mutate(got.data));
      if (!res.ok) console.error("[probe] 落盘失败（重试过）：", res.error);
    })
    .catch(() => undefined); // 探测记录写不进去不影响使用
}

/** 读一次探测记录（内部用）。 */
async function readProbes(): Promise<ProbeRecord> {
  const got = await store.read();
  if (got.foreign) console.error("[probe] 磁盘上的探测记录读不动（保留原样）：", got.note);
  return got.data;
}

/**
 * 给内核用的健康账本（Phase 1 D1 的端口适配）。
 *
 * 内核只知道"跑通了叫我一声 / 跑砸了说原因"（`engine/ports/health.ts`）；
 * **落到哪儿**是这里的事（Electron 的 userData）。这个对象就是那句"落到哪儿"。
 */
export const healthStore: HealthStore = {
  markOk: (providerId) => markProviderOk(providerId),
  markFailed: (providerId, note) => markProviderFailed(providerId, note),
};

/** 记一次"真实调用成功"。 */
export function markProviderOk(providerId: string): void {
  const at = new Date().toISOString();
  update((current) => ({ ...current, [providerId]: { verifiedAt: at, ok: true } }));
}

/** 记一次"真实调用失败"，并把原因留在界面上。 */
export function markProviderFailed(providerId: string, note: string): void {
  const at = new Date().toISOString();
  update((current) => ({ ...current, [providerId]: { verifiedAt: at, ok: false, note } }));
}

/**
 * 组装给渲染进程的 provider 列表（含探测结论）。
 * 密钥本体永远不出主进程，这里只回布尔与文案。
 */
export async function listProvidersWithProbe(): Promise<ProviderInfo[]> {
  const probes = await readProbes();
  return listProviders().map((info) => {
    const probe = probes[info.id];
    return {
      ...info,
      keyRef: info.keyRef,
      verified: probe?.ok === true,
      ...(probe && !probe.ok ? { note: probe.note ?? info.note } : {}),
    };
  });
}

export type ProbeOutcome = { id: string; ok: boolean; ms: number; error?: string };

/**
 * 真探测：对每个"有密钥"的 provider 发一次极短请求。
 *
 * 练手不烧额度：max_tokens=1、prompt 只有一个字，且串行执行（避免并发把中转打挂）。
 *
 * @param timeoutMs 单个 provider 的超时
 * @returns 每个 provider 的结果
 */
export async function probeProviders(timeoutMs = 8000): Promise<ProbeOutcome[]> {
  const { createOpenAICompatible } = await import("@ai-sdk/openai-compatible");
  const { generateText } = await import("ai");
  const { resolveSecret } = await import("../../engine/runtime/credentials");

  const out: ProbeOutcome[] = [];
  for (const def of allProviders()) {
    const info = listProviders().find((p) => p.id === def.id);
    if (!info?.available) continue;
    const key = resolveSecret(def.keyRef);
    const started = Date.now();
    /*
     * ⭐ 闸（2026-10-16，审计 P53）：开着 `DSH_NO_REAL_MODEL` 时探测也**不许真出网**。
     * 记成"被闸拦下"而不是"provider 坏了" —— 前者是用户自己的开关，后者会污染健康账本。
     */
    if (realModelBlocked(def.baseURL)) {
      out.push({ id: def.id, ok: false, ms: 0, error: blockedReason("探测 provider", def.baseURL) });
      continue;
    }
    try {
      const client = createOpenAICompatible({
        name: def.id,
        baseURL: def.baseURL,
        apiKey: key ?? undefined,
      });
      await generateText({
        model: client(def.models[0]),
        prompt: "1",
        maxOutputTokens: 1,
        abortSignal: AbortSignal.timeout(timeoutMs),
      });
      const ms = Date.now() - started;
      markProviderOk(def.id);
      out.push({ id: def.id, ok: true, ms });
    } catch (error) {
      const ms = Date.now() - started;
      const message = error instanceof Error ? error.message : String(error);
      markProviderFailed(def.id, `探测失败：${message.slice(0, 120)}`);
      out.push({ id: def.id, ok: false, ms, error: message.slice(0, 160) });
    }
  }
  return out;
}

export { getProvider };

/**
 * 拉取某家 provider 真实的模型清单（2026-10-16）。
 *
 * 两种目标：表里那家（用它自己的地址与密钥）或用户自填的地址与 key。
 * 网络在这一层，解析在 `engine/runtime/modelsFetch.ts`（纯函数，单测钉住）。
 *
 * ⚠️ 密钥**不出主进程**：这里只把它放进请求头，返回值里只有模型名。
 *
 * @param target 目标（providerId 或自填 baseURL + apiKey）
 * @returns 模型名列表；失败时 `ok:false` 且 `error` 是给人看的一句话
 */
export async function fetchModelsFor(
  target: { providerId: string } | { baseURL: string; apiKey: string },
): Promise<{ ok: boolean; models?: string[]; error?: string }> {
  let baseURL: string;
  let apiKey: string | undefined;
  if ("providerId" in target) {
    const info = getProvider(target.providerId);
    if (!info) return { ok: false, error: `没有这家 provider：${target.providerId}` };
    baseURL = info.baseURL;
    apiKey = resolveSecret(info.keyRef) ?? undefined;
    if (!apiKey) return { ok: false, error: `${info.label} 还没有密钥 —— 先填一条再拉` };
  } else {
    baseURL = target.baseURL;
    apiKey = target.apiKey.trim() || undefined;
  }

  try {
    /*
     * ⚠️ 必须走**过闸的** `fetchRemote`（2026-10-16）。这条是"拉 provider 的模型清单"，
     * 也是真出网 —— `engine/runtime/modelGate.test.ts` 的源码守卫逮到过它：
     * 新写的裸 `fetch(provider…)` 会让 `DSH_NO_REAL_MODEL` 这道闸被绕过。
     */
    const res = await fetchRemote(modelsUrlFor(baseURL), "拉取 provider 模型清单", {
      headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {},
      signal: AbortSignal.timeout(20_000),
    });
    const text = await res.text();
    if (!res.ok) {
      return { ok: false, error: `拉取失败（${res.status}）：${text.slice(0, 160) || "没有说明"}` };
    }
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      return { ok: false, error: `返回的不是 JSON：${text.slice(0, 120)}` };
    }
    const models = modelIdsFromJson(parsed);
    if (!models.length) return { ok: false, error: "对方没给出可识别的模型清单（不猜，宁可说没有）" };
    return { ok: true, models };
  } catch (e) {
    const message = String((e as Error)?.message ?? e);
    return { ok: false, error: /timeout|abort/i.test(message) ? "超时（20 秒）——地址对不对？" : message.slice(0, 160) };
  }
}
