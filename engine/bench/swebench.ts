import type { BenchTask } from "./types";

/**
 * SWE-bench 适配层（V6-1a）。
 *
 * ## 这里做什么、不做什么
 *
 * 做：
 *   · 读官方 JSONL（`instance_id` / `repo` / `base_commit` / `problem_statement` / …）；
 *   · 把一条实例变成"一次 agent 回合"的输入；
 *   · 把 agent 的改动收成官方预测格式（`{instance_id, model_name_or_path, model_patch}`）。
 *
 * **不做**：判分。
 * SWE-bench 的判分要按仓库/版本起对应环境（官方 harness 用 Docker 镜像），
 * 自己写一套"差不多"的判分只会得到一个**不能与公开数字对表**的数。
 * 所以本仓只生成预测，判分交给官方 harness（见 `bench/swebench/README.md`）。
 *
 * ## 为什么不把实例数据收进仓库
 *
 * SWE-bench 的数据集很大（Verified 也有 500 条），而且会更新。
 * 收一份快照进仓库 = 以后所有人跑的都是旧集，还以为是新的。
 * 下载/版本钉在 README 里，`--instances` 指向本地文件。
 */

/** 官方 JSONL 里我们需要的字段。 */
export type SweBenchInstance = {
  instance_id: string;
  repo: string;
  base_commit: string;
  problem_statement: string;
  /** 官方集有；预测阶段不用，判分阶段才用。 */
  test_patch?: string;
  /** 解析后统一成数组（官方 JSONL 里可能写成 JSON 字符串）。 */
  FAIL_TO_PASS?: string[];
  PASS_TO_PASS?: string[];
  /** 版本/环境提示（官方集里叫 `environment_setup_commit`、`version` 等，可选）。 */
  version?: string;
};

/** 把 JSONL 里可能写成字符串的列表收窄成数组。 */
function asList(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((x): x is string => typeof x === "string");
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      if (Array.isArray(parsed)) return parsed.filter((x): x is string => typeof x === "string");
    } catch {
      /* 不是 JSON 就当空 */
    }
  }
  return [];
}

/**
 * 解析 SWE-bench JSONL。
 *
 * @param text 文件内容（一行一条 JSON）
 * @returns 实例；坏行**跳过并报出**（不静默吞）
 */
export function parseSweBenchJsonl(text: string): { instances: SweBenchInstance[]; badLines: { line: number; why: string }[] } {
  const instances: SweBenchInstance[] = [];
  const badLines: { line: number; why: string }[] = [];
  text.split("\n").forEach((raw, index) => {
    const line = index + 1;
    if (!raw.trim()) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      badLines.push({ line, why: "不是合法 JSON" });
      return;
    }
    const item = parsed as Record<string, unknown>;
    for (const key of ["instance_id", "repo", "base_commit", "problem_statement"] as const) {
      if (typeof item?.[key] !== "string" || !(item[key] as string).trim()) {
        badLines.push({ line, why: `缺 ${key}` });
        return;
      }
    }
    const id = String(item.instance_id);
    if (!/^[\w.-]+__[\w.-]+$/.test(id)) {
      /* 官方 id 形如 `django__django-11099`（双下划线，不是斜杠）；格式不对多半是别家的数据集 */
      badLines.push({ line, why: `instance_id 格式不像 SWE-bench：${id}` });
      return;
    }
    instances.push({
      instance_id: id,
      repo: String(item.repo),
      base_commit: String(item.base_commit),
      problem_statement: String(item.problem_statement),
      test_patch: typeof item.test_patch === "string" ? item.test_patch : undefined,
      FAIL_TO_PASS: asList(item.FAIL_TO_PASS),
      PASS_TO_PASS: asList(item.PASS_TO_PASS),
      version: typeof item.version === "string" ? item.version : undefined,
    });
  });
  return { instances, badLines };
}

/**
 * 把一条 SWE-bench 实例变成基准任务（**只用于真 provider 的预测生成**）。
 *
 * ⚠️ `grader` 故意留空：判分不在这里做（见文件头）。
 * 谁要是拿 `ding bench run` 跑这套任务，会看到"每个都通过"——那是**没有判分**，
 * 不是"都做对了"。所以 README 里把这条写死，`runBenchSuite` 也只把空判分当通过。
 */
export function toBenchTask(instance: SweBenchInstance): BenchTask {
  return {
    id: instance.instance_id,
    dir: "",
    title: `${instance.repo}@${instance.base_commit.slice(0, 8)}`,
    category: "swebench",
    split: "test",
    description: "SWE-bench 实例：预测由本仓生成，判分交给官方 harness（见 bench/swebench/README.md）",
    turns: [instance.problem_statement],
    replies: undefined,
    mode: "全部允许",
    maxSteps: 40,
    useTools: true,
    grader: {},
    source: {
      kind: "swebench",
      instanceId: instance.instance_id,
      repo: instance.repo,
      baseCommit: instance.base_commit,
      failToPass: instance.FAIL_TO_PASS,
      passToPass: instance.PASS_TO_PASS,
    },
  };
}

/** 官方预测文件的一行。 */
export type SweBenchPrediction = {
  instance_id: string;
  model_name_or_path: string;
  model_patch: string;
};
