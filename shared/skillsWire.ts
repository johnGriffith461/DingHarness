/**
 * 技能桥的**线路形状**（G08，2026-10-18）。
 *
 * 从 `ipc.ts` 抽出来（那个文件顶着 900 行上限）：这里只有形状，没有行为。
 */
export type SkillSummaryWire = {
  id: string;
  name: string;
  description: string;
  triggers: string[];
  paths: string[];
  always: boolean;
};

export type SkillsBridge = {
  /** 列出技能目录里的技能（主进程读盘）。 */
  list: () => Promise<{ dir: string; skills: SkillSummaryWire[] }>;
  /** 按这一轮的话拼一段技能提示（空串 = 没有命中的技能）。 */
  block: (text: string) => Promise<string>;
};
