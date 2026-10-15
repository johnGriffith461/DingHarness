import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { buildEngine } from "../hosts/cli/assembly";
import { EVAL_CASES } from "../engine/eval/cases";
import { runSuite } from "../engine/eval/run";
import { modelInfoOf } from "../engine/runtime/models";
import { allProviders, getProvider } from "../engine/runtime/providers";

/**
 * 跨 provider 质量-成本矩阵（Phase 10.7）。
 *
 * ## ⚠️ 这个脚本**会花钱**，所以默认拒绝运行
 *
 * 方案原文：「同一评测集跑 ≥3 家 provider × 2 个模型档位，输出质量-成本散点」。
 * 那需要**真实的 key 与真实的调用** —— 按本项目的规矩，调用付费外部服务要先经主人同意。
 * 所以这个脚本的第一件事是检查 `--yes-spend`：
 *
 * ```
 * pnpm eval:matrix --yes-spend            # 真的跑（花钱）
 * pnpm eval:matrix                        # 只打印"要跑什么、大概花多少"，不发一次请求
 * ```
 *
 * 不加参数时它做的是**干跑**：列出会用到哪些 provider/模型、用哪几条用例、
 * 以及按目录表单价估的**上界花费**。这样主人可以在花钱之前看到账单的量级。
 *
 * ## 质量怎么量
 *
 * 同一批判据（`engine/eval/cases.ts` 那 63 条里**不需要脚本化模型**的那部分）：
 * 假 provider 那条路是"按脚本回什么"，真 provider 这条路是"它自己决定回什么"。
 * 所以能直接拿同一批断言去量**真实通过率** —— 这正是"质量"在用户眼里的样子。
 *
 * ⚠️ 但要如实说清一条边界：**不是所有用例都能量**。闸门、压缩那些格子依赖具体回什么，
 * 真模型不一定按脚本走（它会自己决定要不要调工具）。所以矩阵只跑那些**判据与脚本无关**的
 * 用例（纯对话 + 工具调用的"能不能跑通"部分），并在报告里写明**跑了哪些、为什么只有这些**。
 *
 * ## 成本怎么算
 *
 * 数字只来自两处：provider 上报的 `usage`（真数）+ 目录表里那条模型的单价（带核实日期）。
 * 目录表里没有的模型 → 单价未知 → **成本列写"未知"**，不编一个数出来。
 */

const ROOT = (() => {
  let dir = process.cwd();
  for (let i = 0; i < 6; i += 1) {
    if (fs.existsSync(path.join(dir, "engine", "eval", "cases.ts"))) return dir;
    dir = path.dirname(dir);
  }
  return process.cwd();
})();

const OUT = path.join(ROOT, "engine", "eval", "provider-matrix.md");

/** 只有这些类别能量真 provider（判据不依赖"模型按脚本回什么"）。 */
const MEASURABLE = new Set(["纯对话"]);

/** 每家 provider 要测的档位（哪条便宜、哪条贵 —— 由目录表里的单价排序决定）。 */
const TIERS = 2;

type Row = {
  provider: string;
  model: string;
  rate: number;
  total: number;
  passed: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number | null;
  ms: number;
  note: string;
};

/** 这一轮会用到哪些 (provider, model)，以及按目录表估的花费上界。 */
function plan(): Array<{ provider: string; model: string; priceKnown: boolean }> {
  const out: Array<{ provider: string; model: string; priceKnown: boolean }> = [];
  for (const p of allProviders()) {
    // 本机那个 strata 是给假 provider 用的，不算一家"真"供应商
    if (p.id === "strata") continue;
    const hasKey = Boolean(process.env[p.keyRef]?.trim());
    if (!hasKey) continue;
    const models = p.models.slice(0, TIERS);
    for (const m of models) out.push({ provider: p.id, model: m, priceKnown: modelInfoOf(m).priceIn !== undefined });
  }
  return out;
}

async function main(): Promise<void> {
  const yes = process.argv.includes("--yes-spend");
  const cases = EVAL_CASES.filter((c) => MEASURABLE.has(c.category));
  const targets = plan();

  if (!targets.length) {
    console.log("没有可用的真 provider（没有哪家的 key 在环境里）。");
    console.log("配置方式见 README 的「配置模型」一节；这个脚本只读环境变量，不落盘任何 key。");
    return;
  }

  console.log(`计划：${targets.length} 个 provider×模型组合 × ${cases.length} 条用例`);
  for (const t of targets) console.log(`  · ${t.provider} / ${t.model}${t.priceKnown ? "" : "（目录表里没有单价 → 成本未知）"}`);
  console.log(`用例只取「${[...MEASURABLE].join("、")}」类 —— 别的类依赖「模型按脚本回什么」，真模型不保证照做。`);
  console.log("");

  if (!yes) {
    console.log("⚠️ 这是**干跑**：一次请求都没发。要真的跑（会花钱）请加 --yes-spend：");
    console.log("   pnpm eval:matrix --yes-spend");
    return;
  }

  const rows: Row[] = [];
  for (const target of targets) {
    const providerDef = getProvider(target.provider);
    if (!providerDef) {
      rows.push({ ...target, rate: 0, total: 0, passed: 0, inputTokens: 0, outputTokens: 0, costUsd: null, ms: 0, note: "provider 不在表里" });
      continue;
    }
    process.stdout.write(`跑 ${target.provider}/${target.model} … `);
    const started = Date.now();
    const report = await runSuite(cases, {
      provider: target.provider,
      model: target.model,
      fakeProvider: false, // ← 打真端点
      makeEngine: async (workDir) => {
        const storeDir = fs.mkdtempSync(path.join(os.tmpdir(), "dh-matrix-store-"));
        const built = await buildEngine([workDir], storeDir);
        return {
          engine: built.engine,
          close: () => {
            built.close();
            fs.rmSync(storeDir, { recursive: true, force: true });
          },
        };
      },
      sessionPrefix: `matrix-${target.provider}`,
    });

    const inputTokens = report.results.reduce((n, r) => n + r.usage.input, 0);
    const outputTokens = report.results.reduce((n, r) => n + r.usage.output, 0);
    const info = modelInfoOf(target.model);
    /*
     * 成本只按**目录表里的单价**算；没有单价就写"未知"——
     * 编一个数出来会让这张表失去"给选型当依据"的资格。
     */
    const costUsd =
      info.priceIn !== undefined && info.priceOut !== undefined
        ? (inputTokens / 1e6) * info.priceIn + (outputTokens / 1e6) * info.priceOut
        : null;

    rows.push({
      provider: target.provider,
      model: target.model,
      rate: report.rate,
      total: report.total,
      passed: report.passed,
      inputTokens,
      outputTokens,
      costUsd,
      ms: Date.now() - started,
      note: "",
    });
    console.log(`通过率 ${report.rate}%（${report.passed}/${report.total}），${Date.now() - started}ms`);
  }

  /* 散点：横轴成本、纵轴质量 —— 用字符画，够看清"便宜又好用"在哪 */
  const priced = rows.filter((r) => r.costUsd !== null && r.total > 0);
  const scatter: string[] = [];
  if (priced.length) {
    const maxCost = Math.max(...priced.map((r) => r.costUsd ?? 0));
    scatter.push("质量（通过率 %）↑");
    for (const band of [100, 90, 80, 70, 60, 50]) {
      const line: string[] = [];
      for (let col = 0; col < 10; col += 1) {
        const lo = (maxCost * col) / 10;
        const hi = (maxCost * (col + 1)) / 10;
        const hit = priced.some((r) => (r.costUsd ?? 0) >= lo && (r.costUsd ?? 0) < hi && r.rate >= band && r.rate < band + 10);
        line.push(hit ? " ● " : " · ");
      }
      scatter.push(`${String(band).padStart(3)} │${line.join("")}`);
    }
    scatter.push("    └" + "───".repeat(10) + "→ 花费（USD）");
    scatter.push(`    0${" ".repeat(26)}${maxCost.toFixed(4)}`);
  }

  const md = [
    "# 跨 provider 质量-成本矩阵（Phase 10.7）",
    "",
    "> 由 `pnpm eval:matrix --yes-spend` 生成。**这张表会花钱** —— 所以默认不跑，",
    "> 不加 `--yes-spend` 只打印计划（会用哪些 provider、哪几条用例）。",
    "",
    `生成时间：${new Date().toISOString()}`,
    `用例：${cases.length} 条（只取「${[...MEASURABLE].join("、")}」类）`,
    "",
    "## 质量-成本",
    "",
    "| provider | 模型 | 通过率 | 通过/总数 | 输入 tokens | 输出 tokens | 花费 | 耗时 | 备注 |",
    "|---|---|---|---|---|---|---|---|---|",
    ...rows.map(
      (r) =>
        `| ${r.provider} | ${r.model} | ${r.rate}% | ${r.passed}/${r.total} | ${r.inputTokens} | ${r.outputTokens} | ${
          r.costUsd === null ? "**未知**（目录表没这条模型的单价）" : `$${r.costUsd.toFixed(4)}`
        } | ${r.ms}ms | ${r.note} |`,
    ),
    "",
    "## 散点",
    "",
    "```",
    ...(scatter.length ? scatter : ["（没有可画的点：没有哪条模型有已知单价）"]),
    "```",
    "",
    "## 如实记下的边界",
    "",
    `1. **只跑了「${[...MEASURABLE].join("、")}」类用例**：其余类别（闸门审批 / 子智能体 / 多 agent /`,
    "   上下文压缩）的判据依赖「模型按脚本回什么」，真模型不保证照做 ——",
    "   拿它们去量真模型，红的是脚本而不是模型。所以矩阵**不声称覆盖全部 63 条**。",
    "2. **花费只按目录表单价算**：目录表没有那条模型的单价时写「未知」，不编数。",
    "   单价本身带核实日期（`pnpm vendor:models`），过期会在 `ding models` 里标出来。",
    "3. **一次采样**：同一个模型只跑一遍，通过率的抖动没有做重复测量 ——",
    "   差几个百分点的两家**在这个样本量下分不出高低**。",
    "4. **这张表是选型建议的数据源，不是结论**：用户的实际任务分布与这 9 条用例不同。",
    "",
  ].join("\n");
  fs.writeFileSync(OUT, md, "utf8");
  console.log(`\n记录已写入 ${path.relative(ROOT, OUT)}`);
}

void main();
