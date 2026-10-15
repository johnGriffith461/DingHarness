import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

import { buildEngine } from "../../hosts/cli/assembly";
import { EVAL_CASES } from "./cases";
import { runSuite, type EvalReport } from "./run";
import { EVAL_CATEGORIES } from "./types";

/**
 * 评测集：**离线跑、不烧一分钱、有基线棘轮**（Phase 10.1 / 10.2 / 10.3）。
 *
 * ## 为什么它是单测而不是一条 CLI 脚本
 *
 * 方案 10.2 要求"一条命令出报告"（`ding eval`），10.3 要求"通过率跌超 5% 即红"。
 * 这两件事的**判定**必须在 CI 里自动发生 —— 所以：
 *
 *   · 判定在这里（vitest，每次 push 都跑）；
 *   · 给人看的报告在 `ding eval`（同一份 `runSuite`，只是渲染不同）。
 *
 * 一个跑、一个看，共用同一个执行器 —— 不会出现"CI 里的判据与命令行看到的不一致"。
 *
 * ## 装配为什么从 `hosts/cli/assembly.ts` 来
 *
 * 评测必须走**产品那条装配路**（同一批工具、同一个闸门、同一个存储）。
 * 评测器自己拼一套端口的话，测出来的是那套端口的质量，不是产品的。
 */

const BASELINE = path.resolve(__dirname, "baseline.json");
/** 允许的跌幅（方案 10.3 的原文：跌超 5% 即红）。 */
const MAX_DROP = 5;

let report: EvalReport;

beforeAll(async () => {
  report = await runSuite(EVAL_CASES, {
    /*
     * 每个用例：一个临时工作目录（工具能碰的范围）+ 一个临时数据目录（会话库）。
     * 两者都不能落在真实 userData 上 —— 评测跑在 CI 上，不该碰任何真实数据。
     */
    makeEngine: async (workDir) => {
      const storeDir = fs.mkdtempSync(path.join(os.tmpdir(), "dh-eval-store-"));
      const built = await buildEngine([workDir], storeDir);
      return {
        engine: built.engine,
        close: () => {
          built.close();
          fs.rmSync(storeDir, { recursive: true, force: true });
        },
      };
    },
    sessionPrefix: "eval",
  });
  // 让失败信息一次看全（默认只在断言里打一行）
  if (report.failed) {
    for (const r of report.results.filter((x) => !x.ok)) {
      console.log(`✗ ${r.id}（${r.category}）${r.title}`);
      for (const f of r.failures) console.log(`    ${f.what}：${f.detail}`);
      console.log(`    实际事件：${r.eventTypes.join(" → ") || "(空)"}`);
    }
  }
}, 300_000);

describe("评测集（Phase 10：离线回放 + 基线棘轮）", () => {
  it("① 六类都有覆盖，且每条至少断两样（事件序列 / 关键文案 / 产物）", () => {
    for (const category of EVAL_CATEGORIES) {
      const n = EVAL_CASES.filter((c) => c.category === category).length;
      expect(n, `「${category}」这一类还没有用例`).toBeGreaterThan(0);
    }
    /*
     * 三样判据**不必每条都齐**（硬凑会写出没有意义的断言 —— 比如"不给工具"那条，
     * 它要验的就是"没有 tool-call"，再加一条文案断言是充数）。
     * 要有的是两件事：
     *   ① **每一条都有可证伪的判据**（turn 类至少一条断言，core 类必须有 coreCheck）；
     *   ② **整批三样都用上了** —— 否则"产物存在性"这类判据会在没人注意的时候整体失效。
     */
    const withNothing = EVAL_CASES.filter((c) => {
      if (c.kind === "core") return !c.coreCheck;
      const e = c.expect ?? {};
      return !(e.events?.length || e.copy?.length || e.files?.length || e.filesAbsent?.length || e.gate || e.toolErrors?.length);
    }).map((c) => c.id);
    expect(withNothing, "这些用例一条判据都没有 —— 它们永远不会红").toEqual([]);

    const used = {
      事件序列: EVAL_CASES.filter((c) => c.expect?.events?.length).length,
      关键文案: EVAL_CASES.filter((c) => c.expect?.copy?.length).length,
      产物: EVAL_CASES.filter((c) => c.expect?.files?.length || c.expect?.filesAbsent?.length).length,
    };
    for (const [kind, n] of Object.entries(used)) {
      expect(n, `整批里「${kind}」这类判据一条都没用到（那一类判据会在无人注意时失效）`).toBeGreaterThan(0);
    }
  });

  it("② 每条用例的期望里都有「过程」判据（事件序列），不只是最终文本", () => {
    const noEvents = EVAL_CASES.filter((c) => c.kind !== "core" && !c.expect?.events?.length).map((c) => c.id);
    expect(noEvents, "只断最终文本的话，「模型直接编了个答案」与「它真的看了文件」长得一模一样").toEqual([]);
  });

  it("③ 全部用例通过（离线回放，一条真 provider 都不调）", () => {
    const detail = report.results
      .filter((r) => !r.ok)
      .map((r) => `${r.id}: ${r.failures.map((f) => `${f.what}(${f.detail})`).join("; ")}`)
      .join(" | ");
    expect(report.failed, detail).toBe(0);
  });

  it("④ 通过率没有跌破基线 5 个百分点（模型/prompt/SDK/引擎变更的棘轮）", () => {
    if (!fs.existsSync(BASELINE)) {
      // 还没有基线时不该红：第一条基线是 `ding eval --update-baseline` 落下来的
      console.log(`（还没有基线文件 ${path.relative(process.cwd(), BASELINE)}：本次通过率 ${report.rate}%）`);
      return;
    }
    const baseline = JSON.parse(fs.readFileSync(BASELINE, "utf8")) as { rate: number; total: number };
    expect(report.rate).toBeGreaterThanOrEqual(
      baseline.rate - MAX_DROP,
    );
    // 用例被删掉也是漂移：总数只该涨
    expect(report.total, `基线有 ${baseline.total} 条，现在只剩 ${report.total} 条`).toBeGreaterThanOrEqual(baseline.total);
  });
});
