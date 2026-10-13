import fs from "node:fs";
import path from "node:path";
import { app } from "electron";
import type { ProviderInfo } from "../../shared/ipc";
import { getProvider, listProviders, PROVIDERS } from "./aiProviders";

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

type ProbeRecord = Record<string, { verifiedAt: string; ok: boolean; note?: string }>;

function probeFile(): string {
  return path.join(app.getPath("userData"), "provider-probe.json");
}

function readProbes(): ProbeRecord {
  try {
    const file = probeFile();
    if (!fs.existsSync(file)) return {};
    return JSON.parse(fs.readFileSync(file, "utf8")) as ProbeRecord;
  } catch {
    return {};
  }
}

function writeProbes(record: ProbeRecord): void {
  try {
    fs.mkdirSync(path.dirname(probeFile()), { recursive: true });
    fs.writeFileSync(probeFile(), JSON.stringify(record, null, 1), "utf8");
  } catch {
    /* 探测记录写不进去不影响使用 */
  }
}

/** 记一次"真实调用成功"。 */
export function markProviderOk(providerId: string): void {
  const record = readProbes();
  record[providerId] = { verifiedAt: new Date().toISOString(), ok: true };
  writeProbes(record);
}

/** 记一次"真实调用失败"，并把原因留在界面上。 */
export function markProviderFailed(providerId: string, note: string): void {
  const record = readProbes();
  record[providerId] = { verifiedAt: new Date().toISOString(), ok: false, note };
  writeProbes(record);
}

/**
 * 组装给渲染进程的 provider 列表（含探测结论）。
 * 密钥本体永远不出主进程，这里只回布尔与文案。
 */
export function listProvidersWithProbe(): ProviderInfo[] {
  const probes = readProbes();
  return listProviders().map((info) => {
    const probe = probes[info.id];
    return {
      ...info,
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
  const { resolveSecret } = await import("./credentials");

  const out: ProbeOutcome[] = [];
  for (const def of PROVIDERS) {
    const info = listProviders().find((p) => p.id === def.id);
    if (!info?.available) continue;
    const key = resolveSecret(def.keyRef);
    const started = Date.now();
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
