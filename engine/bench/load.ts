import fs from "node:fs";
import path from "node:path";

import type { BenchCategory, BenchEnvLock, BenchSplit, BenchTask } from "./types";

/**
 * 任务集加载（V6-1a）。
 *
 * ## 为什么任务用 JSON 而不是 TS
 *
 * 公开基准的任务定义要能被**陌生人读、改、加**，也要能被脚本（爬山/容器/官方 harness）
 * 吃。TS 任务集只能被本仓的编译器吃 —— 那就不是公开集，是内部夹具。
 *
 * ## 目录口径
 *
 * ```
 * bench/
 *   suites/<suite>.json        ← { name, description, tasks: ["../tasks/<id>", ...] }
 *   tasks/<id>/task.json       ← 任务本身
 *   tasks/<id>/seed/…          ← 初始工作目录（按原样拷进临时目录）
 * ```
 *
 * 任务目录**不写绝对路径**：`{{dir}}` 在运行时替换成临时工作目录
 * （与 `engine/eval` 同一套约定，任务不会跟着机器漂）。
 */

const CATEGORIES: readonly BenchCategory[] = [
  "bugfix",
  "feature",
  "refactor",
  "docs",
  "long-horizon",
  "recovery",
  "swebench",
];

/** 往上找 `bench/suites` 标记（tsx/ESM/CJS 三种跑法都对）。 */
export function benchRoot(start = process.cwd(), dirname?: string): string {
  const starts = [start, ...(dirname ? [dirname] : [])];
  for (const base of starts) {
    let dir = path.resolve(base);
    for (let i = 0; i < 8; i += 1) {
      if (fs.existsSync(path.join(dir, "bench", "suites"))) return dir;
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  throw new Error(`找不到 bench/suites（从 ${start} 往上找 8 层）。请在仓库根目录运行，或用 --suite 指定文件。`);
}

/** 一个 suite 文件。 */
export type BenchSuite = {
  name: string;
  description?: string;
  /** 相对 suite 文件的路径（也可以是任务目录的绝对路径）。 */
  tasks: string[];
};

function asStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.some((x) => typeof x !== "string")) return null;
  return value as string[];
}

/** 收窄一个任务 JSON（磁盘内容按不可信处理）。 */
export function normalizeTask(raw: unknown, dir: string): BenchTask {
  if (!raw || typeof raw !== "object") throw new Error(`${dir}: task.json 不是对象`);
  const t = raw as Record<string, unknown>;
  const id = typeof t.id === "string" ? t.id.trim() : "";
  if (!id) throw new Error(`${dir}: 缺 id`);
  const title = typeof t.title === "string" ? t.title.trim() : "";
  if (!title) throw new Error(`${dir}: 缺 title`);
  const category = t.category as BenchCategory;
  if (!CATEGORIES.includes(category)) throw new Error(`${dir}: category 不在 ${CATEGORIES.join("/")} 里：${String(t.category)}`);
  const split = t.split as BenchSplit;
  if (split !== "train" && split !== "test") throw new Error(`${dir}: split 只能是 train/test：${String(t.split)}`);
  const turns = asStringArray(t.turns);
  if (!turns || turns.length === 0) throw new Error(`${dir}: turns 必须是非空字符串数组`);

  const grader = t.grader;
  if (!grader || typeof grader !== "object") throw new Error(`${dir}: 缺 grader`);
  const g = grader as Record<string, unknown>;
  if (g.files !== undefined && !Array.isArray(g.files)) throw new Error(`${dir}: grader.files 必须是数组`);
  if (g.commands !== undefined && !Array.isArray(g.commands)) throw new Error(`${dir}: grader.commands 必须是数组`);
  for (const f of (g.files as unknown[]) ?? []) {
    const item = f as Record<string, unknown>;
    if (!item || typeof item.path !== "string" || !item.path) throw new Error(`${dir}: grader.files[].path 必填`);
  }
  for (const c of (g.commands as unknown[]) ?? []) {
    const item = c as Record<string, unknown>;
    const argv = asStringArray(item?.argv);
    if (!argv || argv.length === 0) throw new Error(`${dir}: grader.commands[].argv 必须是非空字符串数组`);
  }

  const seed = typeof t.seed === "string" ? t.seed : undefined;
  if (seed) {
    const seedDir = path.resolve(dir, seed);
    if (!fs.existsSync(seedDir)) throw new Error(`${dir}: seed 目录不存在：${seed}`);
  }

  return {
    id,
    dir,
    title,
    category,
    split,
    description: typeof t.description === "string" ? t.description : undefined,
    seed,
    environment: (t.environment as BenchEnvLock | undefined) ?? undefined,
    turns,
    replies: (t.replies as BenchmarkReplies | undefined) ?? undefined,
    mode: t.mode as BenchTask["mode"],
    maxSteps: typeof t.maxSteps === "number" ? t.maxSteps : undefined,
    useTools: typeof t.useTools === "boolean" ? t.useTools : undefined,
    grader: {
      files: (g.files as BenchTask["grader"]["files"]) ?? [],
      commands: (g.commands as BenchTask["grader"]["commands"]) ?? [],
    },
    source: (t.source as BenchTask["source"] | undefined) ?? undefined,
  };
}

/** 只为收窄 `replies` 的形状（真正的语义校验在起假 provider 时）。 */
type BenchmarkReplies = NonNullable<BenchTask["replies"]>;

/** 读一个 suite 文件（`name` 可以是 `harness`、`harness.json` 或一个路径）。 */
export function loadSuite(nameOrPath: string, root = benchRoot()): { suite: BenchSuite; tasks: BenchTask[]; file: string } {
  const candidates = fs.existsSync(nameOrPath)
    ? [path.resolve(nameOrPath)]
    : [
        path.join(root, "bench", "suites", nameOrPath),
        path.join(root, "bench", "suites", `${nameOrPath}.json`),
      ];
  const file = candidates.find((p) => fs.existsSync(p));
  if (!file) throw new Error(`找不到 suite：${nameOrPath}（找过：${candidates.join(" / ")}）`);
  const raw = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
  const suiteName = typeof raw.name === "string" && raw.name ? raw.name : path.basename(file, ".json");
  const list = asStringArray(raw.tasks);
  if (!list || list.length === 0) throw new Error(`${file}: tasks 必须是非空字符串数组`);
  const tasks = list.map((rel) => {
    const dir = path.resolve(path.dirname(file), rel);
    const taskFile = path.join(dir, "task.json");
    if (!fs.existsSync(taskFile)) throw new Error(`${file}: 任务不存在：${rel}（缺 ${taskFile}）`);
    return normalizeTask(JSON.parse(fs.readFileSync(taskFile, "utf8")), dir);
  });
  /* id 重复会让报告与过滤失真 —— 直接拒，不做"后者覆盖前者" */
  const seen = new Set<string>();
  for (const task of tasks) {
    if (seen.has(task.id)) throw new Error(`${file}: 任务 id 重复：${task.id}`);
    seen.add(task.id);
  }
  return { suite: { name: suiteName, description: typeof raw.description === "string" ? raw.description : undefined, tasks: list }, tasks, file };
}

/** 版本号比较（只认 `20` / `>=20` / `>=20.11.0` 三种写法）。 */
export function nodeSatisfies(required: string | undefined, actual = process.versions.node): boolean {
  const want = String(required ?? "").trim().replace(/^>=\s*/, "");
  if (!want) return true;
  const parse = (text: string) => text.split(".").map((x) => Number(x) || 0);
  const [rMajor = 0, rMinor = 0, rPatch = 0] = parse(want);
  const [aMajor = 0, aMinor = 0, aPatch = 0] = parse(actual);
  if (aMajor !== rMajor) return aMajor > rMajor;
  if (aMinor !== rMinor) return aMinor > rMinor;
  return aPatch >= rPatch;
}

/**
 * 环境锁检查。
 *
 * @param lock 任务声明的环境
 * @param ctx 当前环境（可注入，测试用）
 * @returns 不满足的原因（跳过用）；满足返回 null
 */
export function envLockProblem(
  lock: BenchEnvLock | undefined,
  ctx: { node?: string; platform?: string; docker?: boolean } = {},
): string | null {
  if (!lock) return null;
  const platform = ctx.platform ?? process.platform;
  if (lock.platforms?.length && !lock.platforms.includes(platform)) {
    return `需要平台 ${lock.platforms.join("/")}，当前 ${platform}`;
  }
  if (!nodeSatisfies(lock.node, ctx.node ?? process.versions.node)) {
    return `需要 Node ${lock.node}，当前 ${ctx.node ?? process.versions.node}`;
  }
  if (lock.docker && ctx.docker === false) {
    return `这个任务要 Docker（${lock.docker.image}），本机没有`;
  }
  return null;
}
