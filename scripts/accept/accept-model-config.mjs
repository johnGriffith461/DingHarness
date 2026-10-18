#!/usr/bin/env node
/**
 * T0 端到端验收：模型能力表单**真的进了发给真 provider 的请求**。
 *
 * ## 为什么用真 provider
 *
 * 能力表单的全部价值在于"声明的东西真的会发出去"。假服务器只能证明
 * 我们的代码把字段塞进了自己造的对象；**真 provider 接受并正常返回**才能证明
 * 那些字段是它认的、位置是对的、值没被上游拒绝。
 *
 * 代价很小：一轮两三个 token 的对话。
 *
 * ## 证据从哪来
 *
 * 1. **请求侧**：包装 `globalThis.fetch` 抓真实出站 body（真发的，不是构造的）；
 * 2. **响应侧**：真 provider 返回 200 且有回应 —— 字段被接受；
 * 3. **节省量**：这一轮的 usage 与墙钟，如实记下（这是 T1 预算的实测基准）。
 *
 * 只有请求侧证据是不够的：那只证明"我们以为自己改对了"。
 *
 * 用法：
 *   node scripts/accept/accept-model-config.mjs --yes-spend
 */
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..");

const PROVIDER = process.env.ACCEPT_PROVIDER ?? "tokenrhythm";
const MODEL = process.env.ACCEPT_MODEL ?? "deepseek-v4.1-flash-1017";

if (!process.argv.includes("--yes-spend")) {
  process.stdout.write(
    `计划：真跑一轮 ${PROVIDER}/${MODEL}（两三个 token，几分钱以内）\n` +
      `  验证：声明的 maxOutputTokens / reasoningLevel 真的写进了出站请求体，且被 provider 接受\n` +
      `  确认后加 --yes-spend\n`,
  );
  process.exit(2);
}
/* ⚠️ 真花钱的路径必须有闸：与 `DSH_NO_REAL_MODEL` 同源，闸开着就不许跑 */
if (process.env.DING_NO_REAL_MODEL?.trim() || process.env.DSH_NO_REAL_MODEL?.trim()) {
  process.stderr.write("零出网闸开着（DING_NO_REAL_MODEL / DSH_NO_REAL_MODEL）：本验收要真调 provider，先取消再跑\n");
  process.exit(2);
}

const { buildEngine } = await import(pathToFileURL(path.join(root, "hosts/cli/assembly.ts")).href);
const { writeModelConfig, readModelConfig } = await import(
  pathToFileURL(path.join(root, "engine/adapters/modelConfigStore.ts")).href
);
const { resolveFor } = await import(pathToFileURL(path.join(root, "engine/runtime/modelConfigResolver.ts")).href);
const { keepTokensFor } = await import(pathToFileURL(path.join(root, "engine/runtime/budget.ts")).href);

const results = [];
const record = (name, ok, detail) => {
  results.push({ name, ok, detail });
  process.stdout.write(`${ok ? "✓" : "✗"} ${name}${detail ? `  —— ${detail}` : ""}\n`);
};

/* 抓真实出站请求：包一层 globalThis.fetch，读一份 clone，不影响原请求 */
const outbound = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  try {
    const text =
      typeof init?.body === "string"
        ? init.body
        : input instanceof Request
          ? await input.clone().text()
          : undefined;
    if (text) outbound.push(JSON.parse(text));
  } catch {
    /* 抓不到就抓不到，不干扰真正的请求 */
  }
  return realFetch(input, init);
};

const dataDir = mkdtempSync(path.join(tmpdir(), "dh-t0-"));
const workDir = mkdtempSync(path.join(tmpdir(), "dh-t0-work-"));

try {
  /* ① 用户声明一个 1M 窗口的模型（这就是「添加模型」表单落盘的内容） */
  const rule = {
    type: "exact",
    providerId: PROVIDER,
    modelId: MODEL,
    manual: true,
    config: {
      properties: {
        contextWindow: 1_000_000,
        supportsToolCall: true,
        inputFormat: { supportsText: true },
      },
      optionSpecs: {
        reasoningLevel: { values: ["low", "high"], map: '{"reasoning": {"effort": "{{reasoningLevel}}"}}' },
        maxOutputTokens: { max: 64_000, map: '{"max_tokens": "{{maxOutputTokens}}"}' },
      },
    },
  };
  writeModelConfig(dataDir, [rule]);

  const resolved = resolveFor({ providerId: PROVIDER, modelId: MODEL }, readModelConfig(dataDir).file.rules);
  const keep = keepTokensFor(MODEL, Date.now(), "long", {
    contextWindow: resolved.contextWindow,
    maxOutputTokens: resolved.maxOutputTokens,
  });
  record(
    "声明 1M 窗口后，历史保留 ≥900k（不是 20k）",
    resolved.contextWindow === 1_000_000 && keep >= 900_000,
    `窗口 ${resolved.contextWindow} / 保留 ${keep}`,
  );

  /* ② 真跑一轮 */
  const startedAt = Date.now();
  const built = await buildEngine([workDir], dataDir);
  let outcome;
  try {
    outcome = await built.engine.run({
      sessionId: "t0-real",
      provider: PROVIDER,
      model: MODEL,
      system: "回答一个字即可。",
      messages: [{ role: "user", content: "说一个字" }],
      mode: "全部允许",
      maxSteps: 1,
      modelConfig: resolved,
      reasoningEffort: "high",
      stallTimeoutMs: 120_000,
    });
  } finally {
    built.close();
  }
  const elapsed = Date.now() - startedAt;

  const sent = outbound.at(-1) ?? {};
  record("真 provider 接受了这一轮（有回应且未报错）", outcome.ok === true, outcome.ok ? "ok" : outcome.error);
  record(
    "出站请求体里带 max_tokens=64000（参数映射真的改写了 body）",
    sent.max_tokens === 64_000,
    `max_tokens=${JSON.stringify(sent.max_tokens)}`,
  );
  record(
    "出站请求体里带 reasoning.effort=high（推理档位映射生效）",
    sent.reasoning?.effort === "high",
    `reasoning=${JSON.stringify(sent.reasoning)}`,
  );
  record("body 不是按 20k 发的（保守默认没覆盖用户声明）", sent.max_tokens !== 20_000, `max_tokens=${JSON.stringify(sent.max_tokens)}`);

  /* ③ 用量：给 T1 的预算一个实测基准（不折算金额，单价随通道变） */
  const usage = outcome?.events?.findLast?.((e) => e.type === "done")?.usage;
  process.stdout.write(
    `\x1b[2m· 实测：墙钟 ${elapsed}ms` +
      (usage ? ` / 输入 ${usage.inputTokens} / 输出 ${usage.outputTokens} token` : " / 用量未上报") +
      `\x1b[0m\n`,
  );

  /* ④ 声明落在数据目录，可随备份/导出走 */
  const file = path.join(dataDir, "models.json");
  const raw = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : null;
  record(
    "models.json 落在数据目录（可随数据目录备份/导出）",
    Array.isArray(raw?.rules) && raw.rules.length === 1,
    file,
  );
} finally {
  globalThis.fetch = realFetch;
  for (const dir of [dataDir, workDir]) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* 清理失败不影响结论 */
    }
  }
}

const failed = results.filter((r) => !r.ok);
process.stdout.write(
  `\n${failed.length === 0 ? "✓ 全部通过" : `✗ ${failed.length} 项未通过`}（${results.length} 项，真 provider ${PROVIDER}/${MODEL}）\n`,
);
process.exit(failed.length === 0 ? 0 : 1);
