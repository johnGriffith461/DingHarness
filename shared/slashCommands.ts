/**
 * `/` 斜杠命令（B2）。
 *
 * 形状照 cc-haha `ComposerReferenceMenu.tsx` 的 trigger/filter/group（只借设计）。
 *
 * 规矩：
 * - 只在**整行只有 `/xxx`**（允许前导空白）时触发；正文中间的 `/` 是路径/分数，不弹。
 * - 未知命令**不发给模型**：提示 `/help`，输入框保留原文让用户改。
 * - 每条命令都映射到**已有动作**，不新增后端。
 */

export type SlashCommandName =
  | "new"
  | "model"
  | "plan"
  | "compact"
  | "context"
  | "init"
  | "export"
  | "cost"
  | "permissions"
  | "help";

export type SlashCommand = {
  name: SlashCommandName;
  aliases?: readonly string[];
  description: string;
  group: "会话" | "上下文" | "模型" | "权限" | "工具" | "帮助";
};

/** 先做这 10 条（全部映射现有能力）。 */
export const SLASH_COMMANDS: readonly SlashCommand[] = [
  { name: "new", description: "新建会话（回到首页、清空输入）", group: "会话" },
  { name: "model", description: "打开模型选择器", group: "模型" },
  { name: "plan", description: "插入「先给计划、不要改文件」的开场要求", group: "会话" },
  { name: "compact", description: "立即压缩更早的对话", group: "上下文" },
  { name: "context", description: "打开用量与上下文明细", group: "上下文" },
  { name: "init", description: "生成 AGENTS.md 草稿（先预览再写）", group: "工具" },
  { name: "export", description: "导出当前会话为 Markdown", group: "会话" },
  { name: "cost", description: "打开用量（与 /context 同页）", group: "上下文", aliases: ["usage"] },
  { name: "permissions", description: "打开权限矩阵", group: "权限", aliases: ["perm"] },
  { name: "help", description: "列出全部命令", group: "帮助", aliases: ["?"] },
] as const;

export type SlashTrigger = {
  start: number;
  end: number;
  query: string;
};

/**
 * 光标处是不是正在敲斜杠命令。
 *
 * @returns 触发信息；不是命令则 null
 */
export function detectSlashTrigger(text: string, caret: number): SlashTrigger | null {
  const src = String(text ?? "");
  const pos = Math.max(0, Math.min(caret, src.length));
  /* 代码围栏里不触发（那是代码，不是命令） */
  if (((src.slice(0, pos).match(/```/g) ?? []).length) % 2 === 1) return null;

  const lineStart = src.lastIndexOf("\n", pos - 1) + 1;
  const beforeCaret = src.slice(lineStart, pos);
  const leading = beforeCaret.match(/^\s*/)?.[0].length ?? 0;
  const token = beforeCaret.slice(leading);
  if (!token.startsWith("/")) return null;
  /* 整行只有 /xxx：命令后不能有空格（有空格就是在写正文） */
  if (/\s/.test(token)) return null;
  /* 允许只敲一个 `/`：先弹出完整命令列表，用户再继续输入过滤 */
  return { start: lineStart + leading, end: pos, query: token.slice(1) };
}

/** 按名字/别名前缀筛命令；空查询给全部。 */
export function filterSlashCommands(query: string, list: readonly SlashCommand[] = SLASH_COMMANDS): SlashCommand[] {
  const q = String(query ?? "").trim().toLowerCase();
  if (!q) return [...list];
  return list.filter((c) => c.name.startsWith(q) || (c.aliases ?? []).some((a) => a.startsWith(q)));
}

/**
 * 整段文本是不是一条命令（提交时用）。
 * `/help` 这种整行命令返回命令；正文中间的 `/foo` 返回 null。
 */
export function resolveSlashCommand(text: string): SlashCommand | null {
  const src = String(text ?? "");
  const trigger = detectSlashTrigger(src, src.length);
  if (!trigger) return null;
  const query = trigger.query.toLowerCase();
  return (
    SLASH_COMMANDS.find((c) => c.name === query || (c.aliases ?? []).includes(query)) ?? null
  );
}

/** `/help` 要列的内容（一处生成，菜单与命令输出同一份）。 */
export function renderSlashHelp(): string {
  const groups = [...new Set(SLASH_COMMANDS.map((c) => c.group))];
  return groups
    .map((group) => {
      const items = SLASH_COMMANDS.filter((c) => c.group === group);
      return [`【${group}】`, ...items.map((c) => `/${c.name}  ${c.description}`)].join("\n");
    })
    .join("\n\n");
}
