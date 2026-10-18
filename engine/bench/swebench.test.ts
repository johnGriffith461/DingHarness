import { describe, expect, it } from "vitest";

import {
  isOversizePatch,
  MAX_SOURCE_PATCH_LINES,
  parseSweBenchJsonl,
  SWEBENCH_PATCH_EXCLUDES,
  toBenchTask,
} from "./swebench";

/**
 * SWE-bench 适配层（V6-1a）。
 *
 * 守两件事：**官方格式读得对**（否则预测文件交不上去），
 * 以及**不判分的事实写在任务上**（`grader` 为空，README 里也说清）。
 *
 * ⚠️ 下面用的是**合成的示例实例**，不是官方数据 —— 这里测的是解析与转换，
 * 不是基准成绩。任何真实成绩都必须来自官方 harness 的判分。
 */

const sample = {
  instance_id: "django__django-11099",
  repo: "django/django",
  base_commit: "0123456789abcdef0123456789abcdef01234567",
  problem_statement: "Fix the thing.",
  test_patch: "diff --git a/tests.py b/tests.py",
  FAIL_TO_PASS: ["tests.test_x"],
  PASS_TO_PASS: JSON.stringify(["tests.test_y"]),
  version: "3.1",
};

describe("SWE-bench JSONL", () => {
  it("合法行能读进来，字符串形式的列表被收窄成数组", () => {
    const { instances, badLines } = parseSweBenchJsonl(JSON.stringify(sample));
    expect(badLines).toEqual([]);
    expect(instances).toHaveLength(1);
    expect(instances[0]).toMatchObject({
      instance_id: "django__django-11099",
      repo: "django/django",
      FAIL_TO_PASS: ["tests.test_x"],
      PASS_TO_PASS: ["tests.test_y"],
    });
  });

  it("坏行跳过并报出行号（不静默吞）", () => {
    const text = ["", "{not json", JSON.stringify({ ...sample, instance_id: "nope" }), JSON.stringify(sample)].join("\n");
    const { instances, badLines } = parseSweBenchJsonl(text);
    expect(instances).toHaveLength(1);
    expect(badLines.map((b) => b.line)).toEqual([2, 3]);
    expect(badLines[0]?.why).toContain("JSON");
    expect(badLines[1]?.why).toContain("格式");
  });

  it("转成任务时判分留空、来源完整（判分交给官方 harness）", () => {
    const [instance] = parseSweBenchJsonl(JSON.stringify(sample)).instances;
    const task = toBenchTask(instance!);
    expect(task.grader).toEqual({});
    expect(task.source).toMatchObject({ kind: "swebench", instanceId: "django__django-11099" });
    expect(task.turns).toEqual(["Fix the thing."]);
    expect(task.replies).toBeUndefined();
  });
});

describe("收补丁的排除规则", () => {
  it("每一条都带 :(exclude)（漏了会把 diff 变成只收这些路径）", () => {
    const wrong = SWEBENCH_PATCH_EXCLUDES.filter((glob) => !glob.startsWith(":(exclude)"));
    expect(wrong, `这些路径没有 :(exclude) 前缀，git 会把它们当成包含过滤：${wrong.join("、")}`).toEqual([]);
  });

  it("覆盖实测到的三类污染：依赖树、Python 缓存、Sphinx 生成目录", () => {
    const joined = SWEBENCH_PATCH_EXCLUDES.join("\n");
    expect(joined).toContain(":(exclude).testlibs/**"); // 87,278 行那条
    expect(joined).toContain(":(exclude)**/__pycache__/**");
    expect(joined).toContain(":(exclude)**/_build/**"); // 1,276,898 行那条
    expect(joined).toContain(":(exclude)**/*.pyc");
  });

  it("行数上限：空补丁不算超、刚好到上限不算超、多一行才算", () => {
    expect(MAX_SOURCE_PATCH_LINES).toBe(3000);
    expect(isOversizePatch("")).toBe(false);
    expect(isOversizePatch("x\n".repeat(MAX_SOURCE_PATCH_LINES - 1) + "x")).toBe(false);
    expect(isOversizePatch("x\n".repeat(MAX_SOURCE_PATCH_LINES) + "x")).toBe(true);
  });
});
