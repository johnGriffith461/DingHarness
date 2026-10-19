/**
 * 项目上下文的**线上形状**（A1/A2）。
 *
 * 桌面主进程读磁盘、渲染层只收结果：渲染进程没有 `process.cwd()`，也不该
 * 有任意读文件的权限。这里只放**数据**，不放实现——`shared/` 不 import `engine/`。
 *
 * 字段与 `engine/runtime/projectContext.ts` 的 `ProjectContext` 保持一致；
 * 那边是"一个行为一个家"，这边是跨进程契约。改字段时两边一起改，
 * `electron/ipc/project.ts` 的赋值会由 TypeScript 兜住。
 */

export type ProjectRuleFileWire = {
  path: string;
  bytes: number;
  mtimeMs: number;
  source: "workspace" | "global";
};

export type ProjectContextWire = {
  cwd: string;
  gitRoot?: string;
  rules: ProjectRuleFileWire[];
  ruleText: string;
  packageManager?: "pnpm" | "npm" | "yarn" | "bun";
  testCommand?: string;
  platform: string;
  truncated: boolean;
  errors?: Array<{ path: string; error: string }>;
};

export type ProjectContextResult = {
  /** 结构化数据（设置页「项目规则」用）。 */
  context: ProjectContextWire;
  /** 已渲染的两段块；直接拼在系统提示词前面。 */
  rendered: string;
};

export type ProjectBridge = {
  /** 读当前工作区的项目上下文（带 mtime 缓存，下一轮自然失效）。 */
  context: () => Promise<ProjectContextResult>;
  /** 设置页「重新加载」：清缓存后重读。 */
  reload: () => Promise<ProjectContextResult>;
  /** `@` 文件/目录候选（在工作区内搜，最多 20 条）。 */
  mentions: (query: string) => Promise<MentionCandidateWire[]>;
  /** 列一个目录的直接子项（目录引用展开用）。 */
  listDir: (dir: string) => Promise<MentionCandidateWire[]>;
  /** 读一个工作区文件（引用展开用；越界/二进制/敏感文件被拒）。 */
  readFile: (path: string) => Promise<
    { ok: true; text: string; path: string } | { ok: false; error: string }
  >;
};

/** 与 `shared/mentions.ts` 的 `MentionCandidate` 同形（shared 不 import engine）。 */
export type MentionCandidateWire = {
  kind: "file" | "dir";
  label: string;
  path: string;
};
