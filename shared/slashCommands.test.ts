import { describe, expect, it } from "vitest";

import {
  SLASH_COMMANDS,
  detectSlashTrigger,
  filterSlashCommands,
  renderSlashHelp,
  resolveSlashCommand,
} from "./slashCommands";

/**
 * B2：`/` 命令的纯逻辑。
 * 最容易坏的两种：正文里的 `/` 也弹菜单；未知命令被当成普通消息发给模型。
 */

describe("detectSlashTrigger", () => {
  it("行首 /help 命中", () => {
    expect(detectSlashTrigger("/help", 5)).toEqual({ start: 0, end: 5, query: "help" });
  });

  it("允许前导空白", () => {
    expect(detectSlashTrigger("   /co", 6)).toEqual({ start: 3, end: 6, query: "co" });
  });

  it("⭐ 正文中间与路径里的 / 不触发", () => {
    expect(detectSlashTrigger("看看 src/foo.ts", 15)).toBeNull();
    expect(detectSlashTrigger("/help 然后呢", 12)).toBeNull();
    expect(detectSlashTrigger("a / b", 5)).toBeNull();
  });

  it("代码块里不触发", () => {
    expect(detectSlashTrigger("```\n/x\n```", 9)).toBeNull();
  });

  it("只敲一个 / 也弹出完整列表（查询词为空）", () => {
    expect(detectSlashTrigger("/", 1)).toEqual({ start: 0, end: 1, query: "" });
  });
});

describe("filterSlashCommands / resolveSlashCommand", () => {
  it("11 条命令都在，且能按前缀筛", () => {
    expect(SLASH_COMMANDS).toHaveLength(11);
    expect(filterSlashCommands("co").map((c) => c.name)).toEqual(["compact", "context", "cost"]);
    expect(filterSlashCommands("").length).toBe(11);
  });

  it("别名能命中（usage → cost，perm → permissions）", () => {
    expect(resolveSlashCommand("/usage")?.name).toBe("cost");
    expect(resolveSlashCommand("/perm")?.name).toBe("permissions");
  });

  it("⭐ 未知命令返回 null（调用方据此提示 /help，不发给模型）", () => {
    expect(resolveSlashCommand("/nope")).toBeNull();
  });

  it("文本里带别的字就不是命令", () => {
    expect(resolveSlashCommand("/help 再解释一下")).toBeNull();
  });
});

describe("renderSlashHelp", () => {
  it("每条命令都出现，且带分组", () => {
    const text = renderSlashHelp();
    for (const c of SLASH_COMMANDS) expect(text).toContain(`/${c.name}`);
    expect(text).toContain("【帮助】");
  });
});
