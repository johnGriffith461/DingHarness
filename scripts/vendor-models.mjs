/**
 * 从 **vendor 的离线快照**生成模型目录表（Phase 5.1 的 vendor 流程）。
 *
 * ## 为什么要有这一步（而不是运行时去拉）
 *
 * 三件事都不该发生在运行期：
 * ① **网络依赖**：拉不到就退化成"不知道"，而"不知道"会让所有上下文预算退回保守值；
 * ② **不可复核**：表里的数字必须能被审阅 —— 一条记录从哪来、什么时候取的，
 *    得写死在仓库里，而不是"某天从网上拿的"；
 * ③ **重复成本**：每个用户启动都拉一遍同样的目录。
 *
 * ## 用法
 *
 * ```
 * node scripts/vendor-models.mjs
 * ```
 *
 * 生成物 `engine/runtime/models.generated.ts` **要提交**（它进代码复核，改动看得见）；
 * 快照 `engine/runtime/models.snapshot.json` 也提交 —— 没有网络的人照样能重新生成出同样的结果。
 *
 * ## 刷新快照是**人工步骤**（如实记，2026-10-15 实测）
 *
 * - 直连 `raw.githubusercontent.com`：连接重置；
 * - 聚合端点 `models.dev/api.json`：三次尝试都中途断开（最长拿到 2.7MB / 连接重置）；
 * - 唯一稳定的是 GitHub 内容接口（`Accept: application/vnd.github.raw`），
 *   而它要挑文件、要处理 432KB 再裁剪。
 *
 * 一个"自动刷新"如果在这台机器上必然失败，写出来只会让下一个人以为是自己网络的问题。
 * 所以脚本只做**从快照生成**这一件必须可复现的事；刷新命令写在这里：
 *
 * ```
 * curl -sSL -H 'Accept: application/vnd.github.raw' \
 *   https://api.github.com/repos/sst/models.dev/contents/models.json -o /tmp/models.json
 * # 再裁成只留 id/name/context_length/pricing/supported_parameters 的
 * # engine/runtime/models.snapshot.json（整份 432KB 里大半是描述文本与链接）
 * ```
 *
 * ## 口径（这一条很要紧）
 *
 * 快照是 **OpenRouter 目录**（别人的聚合视图）。它的 `context` 与 `pricing` 是
 * **它自己转售时的口径**，不一定等于原生 provider 的规格。所以：
 * - 生成的每条在 `note` 里**标明来源与口径**，不让它看起来像我们核过的一手数据；
 * - 我们自己核过的（例如官方文档里读到的）条目在 `models.ts` 里，**优先于**生成物。
 */

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SNAPSHOT = path.join(ROOT, "engine", "runtime", "models.snapshot.json");
const OUT = path.join(ROOT, "engine", "runtime", "models.generated.ts");

/* 用**本地日期**而不是 UTC："核实于哪天"是给人看的，人看的是自己的日历。 */
const now = new Date();
const takenOn = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;

/**
 * **我们要收进表的模型**（显式列，不靠通配）。
 *
 * 理由：目录表是"我们**为这些模型**提供准确数据"的承诺。收几百条进来却每条都只是
 * 别人的转售口径，等于把承诺稀释成噪声 —— 而"未登记模型走保守默认"这条路本来就是好的。
 *
 * - `native`：原生 provider 的模型 id（我们发请求时用的那个）
 * - `snapshotId`：快照里的 id（两边命名规则不同，例如原生 `claude-sonnet-4-5`
 *   在 OpenRouter 那边叫 `anthropic/claude-sonnet-4.5`）
 * - `protocol`：这个模型**原生**说哪种协议
 */
/**
 * `role` 决定 `note` 怎么说 —— 这不是修辞，是两个不同的事实：
 * - `native`：我们要用**这个模型的原生 id**（例如 `claude-sonnet-4-5`）去调官方端点，
 *   而数字来自别人的目录 → **必须**说明"不一定等于原生规格"；
 * - `relay`：我们就是通过**那个目录背后的服务**（OpenRouter）调它，
 *   那么这份数字**正是它自己的口径** —— 这一条反而比原生规格更准。
 */
const SELECTION = [
  /* ── 原生 id（按各家官方端点发请求时用） ── */
  { native: "deepseek-chat", snapshotId: "deepseek/deepseek-chat", protocol: "openai-compatible", capabilities: { toolCall: true } },
  { native: "deepseek-v3.2", snapshotId: "deepseek/deepseek-v3.2", protocol: "openai-compatible", capabilities: { toolCall: true, reasoning: true } },
  { native: "gpt-4o-mini", snapshotId: "openai/gpt-4o-mini", protocol: "openai-compatible", capabilities: { toolCall: true, attachment: true } },
  { native: "gpt-5.4-mini", snapshotId: "openai/gpt-5.4-mini", protocol: "openai-compatible", capabilities: { toolCall: true, reasoning: true, attachment: true } },
  { native: "qwen-plus", snapshotId: "qwen/qwen-plus", protocol: "openai-compatible", capabilities: { toolCall: true } },
  { native: "claude-sonnet-4-5", snapshotId: "anthropic/claude-sonnet-4.5", protocol: "anthropic", capabilities: { toolCall: true, reasoning: true, attachment: true } },
  { native: "claude-opus-4-5", snapshotId: "anthropic/claude-opus-4.5", protocol: "anthropic", capabilities: { toolCall: true, reasoning: true, attachment: true } },
  { native: "claude-haiku-4-5", snapshotId: "anthropic/claude-haiku-4.5", protocol: "anthropic", capabilities: { toolCall: true, attachment: true } },
  { native: "gemini-3.5-flash", snapshotId: "google/gemini-3.5-flash", protocol: "google", capabilities: { toolCall: true, reasoning: true, attachment: true } },
  { native: "gemini-2.5-pro", snapshotId: "google/gemini-2.5-pro", protocol: "google", capabilities: { toolCall: true, reasoning: true, attachment: true } },

  /* ── OpenRouter 的全名 id（我们经它调这些模型时用的就是这个名字） ── */
  { native: "anthropic/claude-sonnet-4.5", snapshotId: "anthropic/claude-sonnet-4.5", protocol: "openai-compatible", capabilities: { toolCall: true, reasoning: true, attachment: true }, role: "relay" },
  { native: "openai/gpt-5.4-mini", snapshotId: "openai/gpt-5.4-mini", protocol: "openai-compatible", capabilities: { toolCall: true, reasoning: true, attachment: true }, role: "relay" },
  { native: "deepseek/deepseek-chat", snapshotId: "deepseek/deepseek-chat", protocol: "openai-compatible", capabilities: { toolCall: true }, role: "relay" },
  { native: "qwen/qwen-plus", snapshotId: "qwen/qwen-plus", protocol: "openai-compatible", capabilities: { toolCall: true }, role: "relay" },
  { native: "google/gemini-2.5-pro", snapshotId: "google/gemini-2.5-pro", protocol: "openai-compatible", capabilities: { toolCall: true, reasoning: true, attachment: true }, role: "relay" },
];

/** 价格：快照里是"每 token 的美元字符串"，表里统一成"每百万 token"的数。 */
function perMillion(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return Math.round(n * 1e6 * 1e6) / 1e6;
}

const snapshot = JSON.parse(readFileSync(SNAPSHOT, "utf8"));
const rows = [];
const missing = [];

for (const sel of SELECTION) {
  const hit = snapshot.models.find((m) => m.id === sel.snapshotId);
  if (!hit || typeof hit.context !== "number" || hit.context <= 0) {
    missing.push(`${sel.native}（快照里没有 ${sel.snapshotId}，或它没有上下文数）`);
    continue;
  }
  rows.push({
    id: sel.native,
    role: sel.role ?? "native",
    snapshotId: sel.snapshotId,
    protocol: sel.protocol,
    contextWindow: hit.context,
    priceIn: perMillion(hit.pricing?.in),
    priceOut: perMillion(hit.pricing?.out),
    priceCacheRead: perMillion(hit.pricing?.cacheRead),
    capabilities: sel.capabilities,
    name: hit.name,
  });
}

/** 只写有值的字段（`priceIn: undefined` 会让复核的人以为"单价是未知的零"）。 */
function priceLines(r) {
  const out = [];
  if (r.priceIn !== undefined) out.push(`    priceIn: ${r.priceIn},`);
  if (r.priceOut !== undefined) out.push(`    priceOut: ${r.priceOut},`);
  if (r.priceCacheRead !== undefined) out.push(`    priceCacheRead: ${r.priceCacheRead},`);
  return out.join("\n");
}

const body = `import type { ModelSpec } from "./models";

/*
 * ⚠️ **本文件是生成的**（\`node scripts/vendor-models.mjs\`）—— 别手改：
 * 改那个脚本的 SELECTION，或换掉 \`engine/runtime/models.snapshot.json\`。
 * 生成它的理由（可复核、离线、不重复拉）见脚本文件头。
 *
 * 数据来源：models.dev 的 \`models.json\`（OpenRouter 目录快照），生成于 ${takenOn}。
 *
 * ⚠️ 口径：这是**别人的转售视图**，不是原生 provider 的规格。所以每条都带 \`note\`
 * 标明这一点。我们**自己核过**的条目在 \`models.ts\` 里，且优先于这份生成物。
 */
export const GENERATED_MODELS: readonly ModelSpec[] = [
${rows
  .map(
    (r) => `  {
    id: ${JSON.stringify(r.id)},
    provider: ${JSON.stringify(r.snapshotId.split("/")[0])},
    protocol: ${JSON.stringify(r.protocol)},
    contextWindow: ${r.contextWindow},
${priceLines(r) ? `${priceLines(r)}\n` : ""}    capabilities: ${JSON.stringify(r.capabilities)},
    source: "https://github.com/sst/models.dev → models.json（OpenRouter 目录快照）",
    verifiedAt: ${JSON.stringify(takenOn)},
    note: ${JSON.stringify(
      r.role === "relay"
        ? `经 OpenRouter 调它时用的就是这个名字，所以这份数字**就是它自己的口径**（快照里的 ${r.snapshotId}，原名「${r.name}」）`
        : `数字取自 OpenRouter 目录（快照里的 ${r.snapshotId}，原名「${r.name}」）—— 是**该目录的口径**，不一定等于原生 provider 的规格`,
    )},
  },`,
  )
  .join("\n")}
];
`;

writeFileSync(OUT, body, "utf8");
process.stdout.write(`[vendor] 写了 engine/runtime/models.generated.ts：${rows.length} 条\n`);
if (missing.length) {
  process.stdout.write(`[vendor] ⚠️ 快照里查不到的（**不猜**，直接从表里缺席 → 走"未登记模型"）：\n`);
  for (const m of missing) process.stdout.write(`  · ${m}\n`);
}
