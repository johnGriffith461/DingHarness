import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { buildEngine } from "../hosts/cli/assembly";
import { hasSecret } from "../engine/runtime/credentials";
import { modelInfoOf } from "../engine/runtime/models";
import { allProviders } from "../engine/runtime/providers";

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
 * ## 质量怎么量（⚠️ 这一节的判据 2026-10-16 重做过）
 *
 * **不能用离线那 63 条**：它们的判据是"脚本里那句台词有没有出现在回注里"
 * （失败长成 `关键文案: 回注里没有「我是 Ding Harness」`）—— 那是给假 provider 写的，
 * 真模型当然不会照台词说。第一次真跑时量出来的 4/9、4/9，量的是"它没照脚本回"，
 * 不是"它答得差"：拿它当质量分是假的。
 *
 * 所以矩阵自带一小组**判据与模型无关**的题（下面 `PROBES`）：答案可以机械核对
 * （算对了没有、按没按要求只回那个词）。它量的是"听懂指令 + 答对"这一层，
 * **不是综合智能** —— 题少、口径坦白、可复现，比一个假数字强。
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

/**
 * 矩阵自带的题：**判据与模型无关**（答案能机械核对）。
 *
 * ⚠️ 六条题量的是"听懂指令 + 答对"，**不是综合智能** —— 别把它当 benchmark 用。
 * 它存在的意义是：给"质量"那一列一个**真数字**，而不是把脚本化断言套到真模型头上。
 * 加题就往这里加一条，判据必须是确定性的（正则、精确匹配、包含），不许用"感觉对不对"。
 */
const PROBES: Array<{ id: string; ask: string; expect: (text: string) => boolean }> = [
  { id: "arith", ask: "把 17 乘以 23，只回阿拉伯数字，不要任何别的字。", expect: (t) => /\b391\b/.test(t) },
  {
    id: "instr-exact",
    ask: "只回三个字符：OK!（不要引号，不要解释）",
    expect: (t) => t.trim().replace(/^["“”']+|["“”']+$/g, "") === "OK!",
  },
  {
    id: "extract",
    ask: "从下面这句话里找出城市名，只回那一个词：我下周三去杭州出差，周五回北京。",
    expect: (t) => t.includes("杭州"),
  },
  { id: "count-letters", ask: "英文单词 strawberry 里有几个字母 r？只回数字。", expect: (t) => /\b3\b/.test(t) },
  {
    id: "sort",
    ask: "把这串按字母升序排好，用逗号加空格分隔，只回结果：cherry, banana, apple",
    expect: (t) => /apple,\s*banana,\s*cherry/.test(t),
  },
  { id: "math-zh", ask: "一加一等于几？只回数字。", expect: (t) => /\b2\b/.test(t) },
];

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
    const hasKey = hasSecret(p.keyRef);
    if (!hasKey) continue;
    const models = p.models.slice(0, TIERS);
    for (const m of models) out.push({ provider: p.id, model: m, priceKnown: modelInfoOf(m).priceIn !== undefined });
  }
  return out;
}

async function main(): Promise<void> {
  const yes = process.argv.includes("--yes-spend");
  const targets = plan();

  if (!targets.length) {
    console.log("没有可用的真 provider（哪家的 key 都没配）。");
    console.log("配置方式见 README 的「配置模型」一节；这个脚本只看 key **有没有**（不看值，也不落盘）。");
    return;
  }

  console.log(`计划：${targets.length} 个 provider×模型组合 × ${PROBES.length} 条题`);
  for (const t of targets) console.log(`  · ${t.provider} / ${t.model}${t.priceKnown ? "" : "（目录表里没有单价 → 成本未知）"}`);
  console.log(`题是矩阵自带的 ${PROBES.length} 条（判据与模型无关，答案可机械核对）—— 量"听懂指令 + 答对"，不是综合智能。`);
  console.log("");

  if (!yes) {
    console.log("⚠️ 这是**干跑**：一次请求都没发。要真的跑（会花钱）请加 --yes-spend：");
    console.log("   pnpm eval:matrix --yes-spend");
    return;
  }

  const rows: Row[] = [];
  for (const target of targets) {
    process.stdout.write(`跑 ${target.provider}/${target.model} … `);
    const started = Date.now();
    const storeDir = fs.mkdtempSync(path.join(os.tmpdir(), "dh-matrix-store-"));
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "dh-matrix-work-"));
    const built = await buildEngine([workDir], storeDir);

    let passed = 0;
    let inputTokens = 0;
    let outputTokens = 0;
    /*
     * 头一条失败原因。**这条不能省**：调用不通（401 / 429 / 账户受限 / 端点不通）
     * 与"答错了"在通过率上长得一样（都是 0），只报 0% 会把人引到错的方向。
     */
    let firstError = "";

    for (const probe of PROBES) {
      try {
        const runResult = await built.engine.run({
          provider: target.provider,
          model: target.model,
          messages: [{ role: "user", content: probe.ask }],
          mode: "按需确认",
          useTools: false,
        });
        const text = runResult.events
          .filter((e): e is { type: "text"; text: string } => e.type === "text")
          .map((e) => e.text)
          .join("");
        const done = runResult.events.find((e) => e.type === "done");
        if (runResult.ok && probe.expect(text)) passed += 1;
        else if (!firstError) firstError = runResult.ok ? "答了但不符合要求" : (runResult.error ?? "这一轮没成功");
        /* ⚠️ 字段名是 `inputTokens` / `outputTokens`（`StepUsage`）—— 别按直觉写 input/output */
        inputTokens += done?.usage?.inputTokens ?? 0;
        outputTokens += done?.usage?.outputTokens ?? 0;
      } catch (e) {
        if (!firstError) firstError = String((e as Error)?.message ?? e).slice(0, 120);
      }
    }

    built.close();
    fs.rmSync(storeDir, { recursive: true, force: true });
    fs.rmSync(workDir, { recursive: true, force: true });

    const info = modelInfoOf(target.model);
    /*
     * 成本只按**目录表里的单价**算；没有单价就写"未知"——
     * 编一个数出来会让这张表失去"给选型当依据"的资格。
     */
    const costUsd =
      info.priceIn !== undefined && info.priceOut !== undefined
        ? (inputTokens / 1e6) * info.priceIn + (outputTokens / 1e6) * info.priceOut
        : null;

    const rate = Math.round((passed / PROBES.length) * 1000) / 10;
    /* 一个都没过 + 有错误 → 那是"调用不通"，不是"答得差"：写明原因（见 firstError 的说明） */
    const note = passed === 0 && firstError ? `**调用不通**：${firstError}` : passed < PROBES.length && firstError ? firstError : "";

    rows.push({
      provider: target.provider,
      model: target.model,
      rate,
      total: PROBES.length,
      passed,
      inputTokens,
      outputTokens,
      costUsd,
      ms: Date.now() - started,
      note,
    });
    console.log(`通过率 ${rate}%（${passed}/${PROBES.length}）${note ? ` — ${note.slice(0, 80)}` : ""}，${Date.now() - started}ms`);
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
    `题目：${PROBES.length} 条（矩阵自带，判据与模型无关 —— 见文末第 1 条）`,
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
    `1. **题目是矩阵自带的 ${PROBES.length} 条**（算对没有 / 有没有按要求只回那个词），`,
    "   判据**与「模型按什么脚本回」无关** —— 所以真模型能判。",
    "   ⚠️ 它量的是「听懂指令 + 答对」这一层，**不是综合智能**；题少，别当 benchmark。",
    "   离线那 63 条**不能**拿来量真模型：它们的判据是「脚本里那句台词有没有出现在回注里」，",
    "   真模型不会照台词说 —— 拿它当质量分，量出来的是「没照脚本回」（2026-10-16 实测过，已改）。",
    "2. **花费只按目录表单价算**：目录表没有那条模型的单价时写「未知」，不编数。",
    "   单价本身带核实日期（`pnpm vendor:models`），过期会在 `ding models` 里标出来。",
    "3. **一次采样**：同一个模型只跑一遍，通过率的抖动没有做重复测量 ——",
    "   差几个百分点的两家**在这个样本量下分不出高低**。",
    "4. **「调用不通」不等于「答得差」**：备注列写明失败原因（限流 / 账户受限 / 端点不通），",
    "   两栏都是 0% 时要先看备注 —— 只报通过率会把人引到错的方向。",
    "5. **这张表是选型建议的数据源，不是结论**：真实任务分布与这 6 条题不同。",
    "",
  ].join("\n");
  fs.writeFileSync(OUT, md, "utf8");
  console.log(`\n记录已写入 ${path.relative(ROOT, OUT)}`);
}

void main();
