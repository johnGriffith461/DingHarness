import type { ConfirmMode } from "../../shared/ipc";
import type { EvalReply } from "../eval/fakeProvider";
import type { FailureKind } from "../eval/failClassifier";

/**
 * ding-bench 的类型（V6-1a）。
 *
 * ## 两类任务，同一套判分
 *
 * | 来源 | 怎么跑 | 判什么 |
 * |---|---|---|
 * | `harness`（本仓自带） | 脚本化 provider（**不烧 token**、确定性） | 任务级产物：文件内容 + 判分命令 |
 * | `swebench`（外部集） | 真 provider（**花钱**，显式 `--yes-spend`） | 官方 harness 判分（本仓只生成预测） |
 *
 * 两者共用"任务 → 临时工作目录 → 跑回合 → 判产物"这条路径，
 * 所以 `harness` 那套能在 CI 里天天跑，而 `swebench` 那套的数字**不会**被
 * 混进同一张成绩表（见 `BenchReport.suite` 与 `BENCHMARKS.md` 的口径）。
 */

export type BenchSplit = "train" | "test";

export type BenchCategory = "bugfix" | "feature" | "refactor" | "docs" | "long-horizon" | "recovery" | "swebench";

/** 文件判分：该文件必须存在，且满足这些条件。 */
export type BenchFileExpect = {
  /** 相对工作目录的路径（`/` 分隔）。 */
  path: string;
  /**
   * 这个文件**该不该存在**（默认 true）。
   *
   * 设为 false 用来判"闸门拦住了"：写操作要审批时，文件必须**没有**落盘。
   * 这一条比"输出里有没有 pending"更硬 —— 后者是过程证据，前者是副作用有没有发生。
   */
  mustExist?: boolean;
  /** 文件内容必须**逐字**等于它（与 `contains` 二选一）。 */
  equals?: string;
  /** 必须包含的片段（全部命中）。 */
  contains?: string[];
  /** 必须**不**包含的片段（全部不命中）。 */
  absent?: string[];
};

/** 命令判分：在任务工作目录里执行，退出码/输出要对得上。 */
export type BenchCommandExpect = {
  /**
   * 命令与参数（**不走 shell**）。
   *
   * 任务集是本仓控制的代码，但"不走 shell"仍是默认：
   * 字符串拼接的 shell 命令在 Windows/Linux 上语义不同，也会把 `;` 当成命令分隔符。
   */
  argv: string[];
  /** 期望退出码（默认 0）。 */
  exitCode?: number;
  stdoutContains?: string[];
  stderrContains?: string[];
  /** 超时（毫秒，默认 30s）。 */
  timeoutMs?: number;
};

/** 一个任务的判分口径。 */
export type BenchGrader = {
  files?: BenchFileExpect[];
  commands?: BenchCommandExpect[];
};

/** 环境锁：不满足就**跳过**（算环境问题，不算产品失败）。 */
export type BenchEnvLock = {
  /** Node 最低版本（`20` / `>=20` / `>=20.11.0` 三种写法都认）。 */
  node?: string;
  /** 允许的平台（`process.platform`）。 */
  platforms?: string[];
  /** 任务是否需要网络（默认 false；本仓自带任务全部 false）。 */
  network?: boolean;
  /** 容器镜像（`--docker` 时用；本仓自带任务默认 node:22-slim）。 */
  docker?: { image: string; note?: string };
};

/** 一个基准任务。 */
export type BenchTask = {
  id: string;
  /**
   * 任务目录（加载时补上；`seed` 相对它解析）。
   *
   * 它不进报告 —— 报告只列结果字段，所以带上绝对路径不会泄漏到公开成绩里。
   */
  dir: string;
  title: string;
  category: BenchCategory;
  split: BenchSplit;
  /** 人读的一句话：这个任务挡的是哪一种坏。 */
  description?: string;
  /** 种子目录（相对任务目录）；为空表示空工作目录。 */
  seed?: string;
  environment?: BenchEnvLock;
  /** 用户每一轮说的话（脚本化 provider 走这条；真 provider 只发第一轮）。 */
  turns: string[];
  /** 每一轮的脚本化回复（与 `turns` 等长）。真 provider 任务不需要。 */
  replies?: EvalReply[][];
  mode?: ConfirmMode;
  maxSteps?: number;
  useTools?: boolean;
  grader: BenchGrader;
  /** 外部来源（swebench 任务才有）。 */
  source?: {
    kind: "swebench";
    instanceId: string;
    repo: string;
    baseCommit: string;
    /** 官方集里的 FAIL_TO_PASS / PASS_TO_PASS（原样保留，判分交给官方 harness）。 */
    failToPass?: string[];
    passToPass?: string[];
  };
};

/** 一条任务的一次运行结果（多次采样时 `runs > 1`）。 */
export type BenchTaskResult = {
  id: string;
  title: string;
  category: BenchCategory;
  split: BenchSplit;
  ok: boolean;
  /** 采样次数。 */
  runs: number;
  passedRuns: number;
  /** 至少一次通过。 */
  passAtK: boolean;
  /** 采样结果不一致（一次绿一次红）。 */
  flaky: boolean;
  ms: number;
  usage: { input: number; output: number };
  failures: { kind: FailureKind; what: string; detail: string }[];
  /** 环境不满足而跳过（不计入失败，也不计入通过）。 */
  skipped?: string;
  /** 这一条实际跑出来的事件类型（排错用）。 */
  eventTypes?: string[];
};

/** 一批任务的总账。 */
export type BenchReport = {
  suite: string;
  generatedAt: string;
  /** 采样次数（pass@k 的 k）。 */
  samples: number;
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  rate: number;
  passAtKRate: number;
  passAllRate: number;
  flaky: number;
  byCategory: Record<string, { total: number; passed: number }>;
  byFailure: Partial<Record<FailureKind, number>>;
  /** 跑这批时的环境（如实记录，别人复现时知道差在哪）。 */
  environment: {
    node: string;
    platform: string;
    docker: boolean;
    suitePath: string;
  };
  results: BenchTaskResult[];
  /** 用量口径：脚本化 provider 的数字**不是账单**。 */
  usageNote: string;
};
