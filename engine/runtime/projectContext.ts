import fs from "node:fs";
import path from "node:path";

/**
 * 项目上下文（A1/A2）：把"这个仓库的规则"和"你在哪"送进模型的第一轮。
 *
 * ## 为什么必须有它
 *
 * 2026-10-19 的源码实测：三个 prompt builder 全是办公助手心智，`AGENTS.md`
 * 全仓**一次都没被读过**；模型既不知道 cwd，也不知道测试命令。于是它拿到
 * "修一下这个失败测试"时只能猜——这正是"看着有、实际没用"的典型。
 *
 * ## 为什么读文件在 engine 里
 *
 * 它不碰全局路径：`cwd` 由宿主传入，`globalDir` 也由宿主显式给（桌面传
 * `~/.ding`，测试传临时目录）。这样内核仍然可以整包单测，不需要 Electron。
 *
 * ## 缓存
 *
 * 按 `mtimeMs + bytes` 缓存正文。不做 `fs.watch`——平台差异大，而且一轮对话
 * 本来就要重新组装系统提示词；文件变了下一轮自然会重读。
 */

export type ProjectRuleFile = {
  path: string;
  bytes: number;
  mtimeMs: number;
  source: "workspace" | "global";
};

export type ProjectContext = {
  cwd: string;
  gitRoot?: string;
  rules: ProjectRuleFile[];
  /** 已截断、已标注来源；无规则时为空串。 */
  ruleText: string;
  packageManager?: "pnpm" | "npm" | "yarn" | "bun";
  /** 只从 `package.json.scripts.test` 探测；探测不到就不写。 */
  testCommand?: string;
  platform: string;
  truncated: boolean;
  /** 读不动的规则文件（权限/编码）。UI 标红用；不阻塞对话。 */
  errors?: Array<{ path: string; error: string }>;
};

/** 同层优先级：override 赢 AGENTS.md，AGENTS.md 赢 CLAUDE.md。 */
const RULE_NAMES = ["AGENTS.override.md", "AGENTS.md", "CLAUDE.md"] as const;

export const PROJECT_CONTEXT_LIMITS = {
  perFileBytes: 32 * 1024,
  totalBytes: 48 * 1024,
} as const;

type CacheEntry = { mtimeMs: number; bytes: number; text: string };

const textCache = new Map<string, CacheEntry>();

/** 测试用：缓存是进程级的，用例之间要能清。 */
export function clearProjectContextCache(): void {
  textCache.clear();
}

function isFile(file: string): boolean {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

/** 从 cwd 向上找 `.git`（目录或 worktree 的 gitfile）。 */
export function findGitRoot(cwd: string): string | undefined {
  let dir = path.resolve(cwd);
  for (;;) {
    if (fs.existsSync(path.join(dir, ".git"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/** cwd 在 gitRoot 之下时，返回 root → cwd 的目录链；无 git 时只返回 cwd。 */
function dirChain(cwd: string, gitRoot: string | undefined): string[] {
  const start = path.resolve(cwd);
  if (!gitRoot) return [start];
  const root = path.resolve(gitRoot);
  const rel = path.relative(root, start);
  if (rel.startsWith("..") || path.isAbsolute(rel)) return [start];
  const out: string[] = [root];
  let current = root;
  for (const part of rel.split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    out.push(current);
  }
  return out;
}

/** 同层取第一个命中的规则文件（不是三个都收）。 */
function ruleAt(dir: string): string | undefined {
  for (const name of RULE_NAMES) {
    const file = path.join(dir, name);
    if (isFile(file)) return file;
  }
  return undefined;
}

/** 按 UTF-8 截断到字节上限；尽量落在换行处，避免切出半个字。 */
function truncateUtf8(text: string, limitBytes: number): { text: string; truncatedBytes: number } {
  const buf = Buffer.from(text, "utf8");
  if (buf.length <= limitBytes) return { text, truncatedBytes: 0 };
  let slice = buf.subarray(0, limitBytes);
  // 不要把一个多字节字符切成替换符：从尾部退到合法边界。
  let end = slice.length;
  while (end > 0 && (slice[end - 1] & 0b1100_0000) === 0b1000_0000) end -= 1;
  if (end > 0 && (slice[end - 1] & 0b1000_0000) !== 0) {
    const lead = slice[end - 1];
    const need = lead >= 0b1111_0000 ? 4 : lead >= 0b1110_0000 ? 3 : lead >= 0b1100_0000 ? 2 : 1;
    if (end - 1 + need > slice.length) end -= 1;
  }
  slice = slice.subarray(0, end);
  let cut = slice.toString("utf8");
  const lastBreak = cut.lastIndexOf("\n");
  if (lastBreak > cut.length * 0.8) cut = cut.slice(0, lastBreak + 1);
  return { text: cut, truncatedBytes: buf.length - Buffer.byteLength(cut, "utf8") };
}

function readRule(file: string, limitBytes: number): { text: string; bytes: number; mtimeMs: number; truncatedBytes: number } {
  const stat = fs.statSync(file);
  const cached = textCache.get(file);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.bytes === stat.size) {
    const limited = truncateUtf8(cached.text, limitBytes);
    return { text: limited.text, bytes: stat.size, mtimeMs: stat.mtimeMs, truncatedBytes: Math.max(0, stat.size - Buffer.byteLength(limited.text, "utf8")) };
  }
  const raw = fs.readFileSync(file, "utf8");
  textCache.set(file, { mtimeMs: stat.mtimeMs, bytes: stat.size, text: raw });
  const limited = truncateUtf8(raw, limitBytes);
  return { text: limited.text, bytes: stat.size, mtimeMs: stat.mtimeMs, truncatedBytes: limited.truncatedBytes };
}

export type LoadProjectContextOptions = {
  /** 单文件上限（默认 32 KiB）。 */
  maxBytes?: number;
  /** 总量上限（默认 48 KiB）。 */
  maxTotalBytes?: number;
  /**
   * 全局规则目录（可选的用户级 `AGENTS.md`）。
   * 由宿主显式给出；内核不猜 `~/.ding` 这种全局路径。
   */
  globalDir?: string;
  /** 平台名；默认 `process.platform`。测试可覆盖（内核仍不读全局路径）。 */
  platform?: string;
};

/**
 * 读一个目录的项目上下文。
 *
 * 规则文件搜索：全局目录 → git root → … → cwd；每层取
 * `AGENTS.override.md` / `AGENTS.md` / `CLAUDE.md` 里**第一个命中的**。
 * 越具体的目录排在越后面，模型读到的是"通用规则在前、局部规则在后"。
 */
export function loadProjectContext(cwd: string, opts: LoadProjectContextOptions = {}): ProjectContext {
  const perFile = Math.max(1, opts.maxBytes ?? PROJECT_CONTEXT_LIMITS.perFileBytes);
  const totalLimit = Math.max(1, opts.maxTotalBytes ?? PROJECT_CONTEXT_LIMITS.totalBytes);
  const resolvedCwd = path.resolve(cwd);
  const gitRoot = findGitRoot(resolvedCwd);
  const dirs = dirChain(resolvedCwd, gitRoot);

  const found: Array<{ file: string; source: "workspace" | "global" }> = [];
  if (opts.globalDir) {
    const globalRule = ruleAt(path.resolve(opts.globalDir));
    if (globalRule) found.push({ file: globalRule, source: "global" });
  }
  for (const dir of dirs) {
    const rule = ruleAt(dir);
    if (rule) found.push({ file: rule, source: "workspace" });
  }

  const rules: ProjectRuleFile[] = [];
  const errors: Array<{ path: string; error: string }> = [];
  const chunks: string[] = [];
  let used = 0;
  let truncated = false;

  for (const { file, source } of found) {
    if (used >= totalLimit) {
      truncated = true;
      break;
    }
    const remaining = totalLimit - used;
    try {
      const got = readRule(file, Math.min(perFile, remaining));
      used += Buffer.byteLength(got.text, "utf8");
      rules.push({ path: file, bytes: got.bytes, mtimeMs: got.mtimeMs, source });
      chunks.push(
        `## ${file}${source === "global" ? "（全局）" : ""}（${got.bytes} 字节）\n${got.text}${got.truncatedBytes > 0 ? `\n（已截断 ${got.truncatedBytes} 字节）` : ""}`,
      );
      if (got.truncatedBytes > 0) truncated = true;
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      errors.push({ path: file, error: reason });
      chunks.push(`规则文件读取失败：${file}（${reason}）`);
    }
  }

  const ctx: ProjectContext = {
    cwd: resolvedCwd,
    ...(gitRoot ? { gitRoot } : {}),
    rules,
    ruleText: chunks.join("\n\n"),
    platform: opts.platform ?? process.platform,
    truncated,
    ...(errors.length ? { errors } : {}),
  };
  return { ...ctx, ...detectEnvironment(ctx) };
}

/**
 * A2：环境事实。
 *
 * 只写探测得到的东西：没有 `scripts.test` 就不写 `test_command`，
 * 探测不到包管理器就不写那一行。**不猜** `pytest`/`make test`——猜错会让模型
 * 跑一个不存在的命令，然后把失败当成"代码坏了"。
 */
export function detectEnvironment(ctx: Pick<ProjectContext, "cwd" | "gitRoot">): Pick<ProjectContext, "packageManager" | "testCommand"> {
  const packageManager = detectPackageManager(ctx.cwd);
  const testCommand = detectTestCommand(ctx.cwd, packageManager);
  return {
    ...(packageManager ? { packageManager } : {}),
    ...(testCommand ? { testCommand } : {}),
  };
}

function detectPackageManager(cwd: string): ProjectContext["packageManager"] {
  const order: Array<[string, ProjectContext["packageManager"]]> = [
    ["pnpm-lock.yaml", "pnpm"],
    ["package-lock.json", "npm"],
    ["yarn.lock", "yarn"],
    ["bun.lockb", "bun"],
  ];
  for (const [file, manager] of order) {
    if (isFile(path.join(cwd, file))) return manager;
  }
  return undefined;
}

function detectTestCommand(cwd: string, packageManager: ProjectContext["packageManager"]): string | undefined {
  const pkgFile = path.join(cwd, "package.json");
  if (!isFile(pkgFile)) return undefined;
  try {
    const raw = fs.readFileSync(pkgFile, "utf8");
    const pkg = JSON.parse(raw) as { scripts?: Record<string, unknown> };
    const test = pkg.scripts?.test;
    if (typeof test !== "string" || !test.trim()) return undefined;
    return `${packageManager ?? "npm"} test`;
  } catch {
    return undefined;
  }
}

/**
 * 渲染成两段：`<project_instructions>` 与 `<environment>`。
 * 空块不输出——"标题下面一片空"会让模型以为规则存在但没读到。
 */
export function renderProjectContext(ctx: ProjectContext): string {
  const blocks: string[] = [];
  if (ctx.ruleText.trim()) {
    blocks.push(
      [
        "<project_instructions>",
        "以下是用户提供的项目说明（来自工作区里的规则文件）。把它当作项目约定来遵守；",
        "它与本次任务的要求冲突时，以用户本次的要求为准。",
        "",
        ctx.ruleText.trim(),
        "</project_instructions>",
      ].join("\n"),
    );
  }

  const env: string[] = [`cwd: ${ctx.cwd}`, `platform: ${ctx.platform}`];
  if (ctx.gitRoot) env.push(`git_root: ${ctx.gitRoot}`);
  if (ctx.packageManager) env.push(`package_manager: ${ctx.packageManager}`);
  if (ctx.testCommand) env.push(`test_command: ${ctx.testCommand}`);
  if (env.length) blocks.push(["<environment>", ...env, "</environment>"].join("\n"));

  return blocks.join("\n\n");
}

/**
 * 把项目上下文拼到系统提示词前面（规则在前、任务要求在后）。
 * 空块原样返回，不多出空行。
 */
export function withProjectContext(system: string, rendered: string): string {
  const block = rendered.trim();
  if (!block) return system;
  return `${block}\n\n${system}`;
}
