#!/usr/bin/env node
/**
 * G1 · 计划模式的**真实模型**验收（不是假 server）。
 *
 * 验三件事：
 *  ① 真 provider 下计划模式能跑通并给出五段计划；
 *  ② 计划模式下**下发的工具名里没有写/命令工具**（看 request 记录，不看模型自述）；
 *  ③ 工作区文件**一个都没变**（快照前后一致）。
 *
 * 用法：
 *   pnpm exec tsx scripts/accept/accept-plan-real.mjs --yes-spend
 *
 * 预算：单条真调用，maxSteps 8；模型与十任务一致（tokenrhythm/deepseek-v4.1-flash-1017）。
 */
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..");
const MODEL = process.env.ACCEPT_MODEL ?? "deepseek-v4.1-flash-1017";
const PROVIDER = process.env.ACCEPT_PROVIDER ?? "tokenrhythm";

if (!process.argv.includes("--yes-spend")) {
  process.stdout.write(`计划：真模型 ${PROVIDER}/${MODEL} 跑一次计划模式验收（会花钱）。确认后加 --yes-spend\n`);
  process.exit(2);
}
if (process.env.DING_NO_REAL_MODEL?.trim() || process.env.DSH_NO_REAL_MODEL?.trim()) {
  process.stderr.write("零出网闸开着（DING_NO_REAL_MODEL / DSH_NO_REAL_MODEL）：这条要真调模型\n");
  process.exit(2);
}

const { buildEngine } = await import(pathToFileURL(path.join(root, "hosts/cli/assembly.ts")).href);
const { writeModelConfig } = await import(pathToFileURL(path.join(root, "engine/adapters/modelConfigStore.ts")).href);
const { resolveFor } = await import(pathToFileURL(path.join(root, "engine/runtime/modelConfigResolver.ts")).href);

const ws = mkdtempSync(path.join(tmpdir(), "dh-plan-real-ws-"));
const dataDir = mkdtempSync(path.join(tmpdir(), "dh-plan-real-data-"));
mkdirSync(path.join(ws, "src"), { recursive: true });
writeFileSync(path.join(ws, "src/math.js"), "export function add(a, b) {\n  return a - b;\n}\n", "utf8");

function snapshot(dir) {
  const out = [];
  const walk = (d, rel = "") => {
    for (const entry of readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(d, entry.name);
      const key = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(full, key);
      else out.push(`${key}:${createHash("sha256").update(readFileSync(full)).digest("hex")}`);
    }
  };
  walk(dir);
  return out.join("\n");
}

const before = snapshot(ws);
writeModelConfig(dataDir, [
  {
    type: "exact",
    providerId: PROVIDER,
    modelId: MODEL,
    manual: true,
    config: {
      properties: { contextWindow: 1_000_000, supportsToolCall: true, inputFormat: { supportsText: true } },
      optionSpecs: { maxOutputTokens: { max: 64_000, map: '{"max_tokens": "{{maxOutputTokens}}"}' } },
    },
  },
]);
const runtime = resolveFor(
  { providerId: PROVIDER, modelId: MODEL },
  [{ type: "exact", providerId: PROVIDER, modelId: MODEL, manual: true, config: {} }],
);

const events = [];
let steps = 0;
let inputTokens = 0;
let outputTokens = 0;
let text = "";
let tools = [];
let ok = false;
let error = "";
const startedAt = Date.now();

const built = await buildEngine([ws], dataDir);
try {
  const outcome = await built.engine.run({
    sessionId: "plan-real",
    provider: PROVIDER,
    model: MODEL,
    system: "你在一个临时工作区里，用只读方式调查后给计划；不要修改任何文件。",
    messages: [
      {
        role: "user",
        content:
          "先读 src/math.js，然后给一份五段计划（目标 / 范围 / 步骤 / 验证 / 风险）来修正里面 add 的实现错误。只给计划，不要改文件。",
      },
    ],
    planMode: true,
    mode: "全部允许",
    useTools: true,
    maxSteps: 8,
    modelConfig: runtime,
    allowUndeclaredModel: true,
    stallTimeoutMs: 5 * 60 * 1000,
    onEvent: (event) => {
      events.push(event);
      if (event.type === "text") text += event.text;
      if (event.type === "step-finish") {
        steps += 1;
        inputTokens += event.usage?.inputTokens ?? 0;
        outputTokens += event.usage?.outputTokens ?? 0;
      }
    },
  });
  ok = outcome.ok;
  error = outcome.error ?? "";
  const request = outcome.records.find((r) => r.type === "request");
  tools = request?.tools ?? [];
} finally {
  built.close();
}

const after = snapshot(ws);
const fiveSections = ["目标", "范围", "步骤", "验证", "风险"].filter((s) => text.includes(s));
const forbidden = tools.filter((name) =>
  ["write_file", "edit_file", "apply_patch", "run_command", "spawn_agent"].includes(name),
);
const checks = {
  runOk: ok,
  fiveSections: fiveSections.length === 5,
  noWriteTools: forbidden.length === 0,
  workspaceUntouched: before === after,
};
const passed = Object.values(checks).every(Boolean);

process.stdout.write(
  [
    `模型：${PROVIDER}/${MODEL}　${steps} 步 / 输入 ${inputTokens} / 输出 ${outputTokens} tok / ${Math.round((Date.now() - startedAt) / 1000)}s`,
    `工具面（request 记录）：${tools.join(", ") || "（空）"}`,
    `五段：${fiveSections.join("、") || "（缺）"}`,
    `工作区未变：${before === after}`,
    passed ? "✓ 计划模式真模型验收通过" : `✗ 失败：${JSON.stringify(checks)} ${error}`,
    "",
    "模型输出（前 1200 字）：",
    text.slice(0, 1200),
  ].join("\n"),
);

try {
  rmSync(ws, { recursive: true, force: true });
  rmSync(dataDir, { recursive: true, force: true });
} catch {
  /* 清理失败不影响结论 */
}
process.exit(passed ? 0 : 1);
