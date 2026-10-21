/**
 * 生成**模型目录快照**（M-07）。
 *
 * 用法：
 *
 * ```bash
 * # 用已经下好的响应（推荐：先 curl 到本地，网络不稳时能重跑）
 * curl -s https://openrouter.ai/api/v1/models -o .verify/openrouter.models.json
 * pnpm build:model-snapshot .verify/openrouter.models.json
 *
 * # 或让脚本自己拉
 * pnpm build:model-snapshot --fetch
 * ```
 *
 * 产物：`engine/runtime/data/models.snapshot.json`（**要提交**）。
 *
 * ⚠️ 为什么不用 `https://models.dev/api.json`（方案原意）：
 * 2026-10-21 实测两次都在 3.2MB 左右被对端截断，`JSON.parse` 直接报
 * "Unterminated string"。OpenRouter 的公开端点稳定，且字段正好够用。
 */
import fs from "node:fs";
import path from "node:path";

import { trimOpenRouterModels } from "../engine/runtime/modelSnapshot";

const SOURCE = "https://openrouter.ai/api/v1/models";
const OUT = path.join("engine", "runtime", "data", "models.snapshot.json");

async function load(arg: string | undefined): Promise<unknown> {
  if (arg === "--fetch" || arg === undefined) {
    if (arg === undefined) {
      const fallback = path.join(".verify", "openrouter.models.json");
      if (!fs.existsSync(fallback)) {
        console.error(`没有输入文件。先下载：curl -s ${SOURCE} -o ${fallback}`);
        process.exit(1);
      }
      return JSON.parse(fs.readFileSync(fallback, "utf8")) as unknown;
    }
    console.log(`拉取 ${SOURCE} …`);
    const res = await fetch(SOURCE, { signal: AbortSignal.timeout(120_000) });
    if (!res.ok) {
      console.error(`拉取失败：HTTP ${res.status}`);
      process.exit(1);
    }
    const text = await res.text();
    try {
      return JSON.parse(text) as unknown;
    } catch {
      console.error(`返回的不是完整 JSON（${text.length} 字节）—— 多半又被截断了，重试或改用本地文件`);
      process.exit(1);
    }
  }
  if (!fs.existsSync(arg)) {
    console.error(`输入文件不存在：${arg}`);
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(arg, "utf8")) as unknown;
}

const raw = await load(process.argv[2]);
const models = trimOpenRouterModels(raw);
if (models.length < 10) {
  console.error(`只裁剪出 ${models.length} 条 —— 数量不对，先检查输入是不是完整响应`);
  process.exit(1);
}

const payload = {
  _source: SOURCE,
  _generatedAt: new Date().toISOString().slice(0, 10),
  _note: "OpenRouter 目录快照：context_length / top_provider.max_completion_tokens / architecture.input_modalities / supported_parameters。是聚合口径，不一定是原生 provider 的规格。",
  models,
};

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(payload, null, 1) + "\n", "utf8");
console.log(`已写入 ${OUT}：${models.length} 条（${(fs.statSync(OUT).size / 1024).toFixed(0)} KB）`);
