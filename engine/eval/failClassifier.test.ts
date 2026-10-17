import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { buildEngine } from "../../hosts/cli/assembly";
import {
  FAILURE_KINDS,
  FAILURE_KIND_LABELS,
  describeFailureSummary,
  summarizeFailures,
  type FailureKind,
} from "./failClassifier";
import { runSuite } from "./run";
import type { EvalCase } from "./types";

/**
 * 失败分类器与 pass@k（V6-1d）。
 *
 * 这两件事产品上看不见，但它们是"公开成绩可跨版本比较"的前提：
 *   · 分类器把判红点收成**封闭枚举** —— 文案改了，历史成绩还能对齐；
 *   · pass@k 把"多试几次能不能过"与"每次都过"分开 —— 只报前者是把
 *     "偶尔能过"说成"能过"。
 */

describe("失败分类器", () => {
  it("每条失败都归到封闭表里的一个键，且标签齐全", () => {
    for (const kind of FAILURE_KINDS) {
      expect(FAILURE_KIND_LABELS[kind], `「${kind}」没有给人看的标签`).toBeTruthy();
    }
  });

  it("按类别汇总：计数正确、键顺序稳定（同一份输入永远同序）", () => {
    const failures: { kind: FailureKind }[] = [
      { kind: "artifact" },
      { kind: "event_sequence" },
      { kind: "artifact" },
      { kind: "ledger" },
    ];
    const summary = summarizeFailures(failures);
    expect(summary).toEqual({ event_sequence: 1, artifact: 2, ledger: 1 });
    expect(Object.keys(summary)).toEqual(["event_sequence", "artifact", "ledger"]);
  });

  it("汇总文案带上人话标签与次数", () => {
    expect(describeFailureSummary({ event_sequence: 2, copy_presentation: 1 })).toBe(
      "过程不对（事件序列）×2 · 回注缺失（用户可见文案）×1",
    );
    expect(describeFailureSummary({})).toBe("");
  });
});

describe("pass@k 采样", () => {
  /** 两条纯函数格子：一条恒过、一条恒红（不依赖 provider，秒级跑完）。 */
  const cases: EvalCase[] = [
    {
      id: "classifier-pass",
      category: "纯对话",
      title: "恒过的纯函数格子",
      kind: "core",
      coreCheck: () => null,
    },
    {
      id: "classifier-fail",
      category: "纯对话",
      title: "恒红的纯函数格子（用来验分类键）",
      kind: "core",
      coreCheck: () => "这条故意红",
    },
  ];

  it("k=3：pass@k / pass^k 分开报，失败带上稳定类别", async () => {
    const storeDirs: string[] = [];
    const report = await runSuite(
      cases,
      {
        makeEngine: async (workDir) => {
          const storeDir = fs.mkdtempSync(path.join(os.tmpdir(), "dh-classifier-"));
          storeDirs.push(storeDir);
          const built = await buildEngine([workDir], storeDir);
          return { engine: built.engine, close: () => built.close() };
        },
        sessionPrefix: "classifier",
      },
      undefined,
      { repeat: 3 },
    );

    expect(report.samples).toBe(3);
    expect(report.total).toBe(2);
    /* 严格口径：一条全过、一条全红 → 50%。pass@3 也是 50%（没有任何一条"偶尔过"） */
    expect(report.rate).toBe(50);
    expect(report.passAtKRate).toBe(50);
    expect(report.passAllRate).toBe(50);
    expect(report.flaky).toBe(0);
    expect(report.byFailure.core_check).toBe(3); // 红的那条 × 3 次采样
    expect(report.byFailure.exception).toBeUndefined();

    const failing = report.results.find((r) => r.id === "classifier-fail");
    expect(failing?.ok).toBe(false);
    expect(failing?.failureKinds).toEqual(["core_check"]);
    expect(failing?.runs).toBe(3);
    expect(failing?.passedRuns).toBe(0);
    expect(failing?.passAtK).toBe(false);

    const passing = report.results.find((r) => r.id === "classifier-pass");
    expect(passing?.ok).toBe(true);
    expect(passing?.passedRuns).toBe(3);

    for (const dir of storeDirs) fs.rmSync(dir, { recursive: true, force: true });
  });
});
