import { describe, expect, it } from "vitest";
import { CONFIRM_MODES, decide, policyOf } from "@shared/permissions";
import {
  MAX_MCP_SERVERS,
  MCP_LABELS,
  MCP_TOOL_PREFIX,
  emptyMcpConfig,
  isMcpTool,
  isValidServerName,
  mcpToolName,
  normalizeMcpConfig,
  parseMcpToolName,
  serverStatusLine,
  serverUsable,
} from "@shared/mcp";

/**
 * 连接器（MCP）的纯逻辑（2026-10-14）。
 *
 * 这一层钉两件事：
 * ① **配置不可信**（磁盘上手改过的 `mcp.json` 不许把工具集搞崩：坏名字直接丢）；
 * ② **工具名的形状** —— 它是闸门判断"要不要按外部工具对待"的唯一依据，
 *    也是"调用时要还原成哪个 server 的哪个工具"的唯一依据，两头都得对得上。
 */
describe("名字的形状", () => {
  it("`mcp__<server>__<tool>` 拼得出来也拆得回去", () => {
    const name = mcpToolName("files", "read_file");
    expect(name).toBe("mcp__files__read_file");
    expect(parseMcpToolName(name)).toEqual({ server: "files", tool: "read_file" });
  });

  it("非法字符一律压成下划线（工具名要能安全地出现在各处）", () => {
    expect(mcpToolName("My Server!", "read:file")).toBe("mcp__my_server__read_file");
  });

  it("不是 MCP 名字 → 拆不出来（返回 null，别猜）", () => {
    expect(parseMcpToolName("read_file")).toBeNull();
    expect(parseMcpToolName("mcp__onlyserver")).toBeNull();
    expect(isMcpTool("read_file")).toBe(false);
    expect(isMcpTool(MCP_TOOL_PREFIX + "a__b")).toBe(true);
  });
});

describe("配置不可信", () => {
  it("正常形状原样保留", () => {
    const got = normalizeMcpConfig({ servers: [{ name: "files", command: "npx", args: ["-y", "x"] }] });
    expect(got.servers).toEqual([{ name: "files", command: "npx", args: ["-y", "x"] }]);
  });

  it("裸数组也认（老数据没有信封）", () => {
    expect(normalizeMcpConfig([{ name: "a", command: "b" }]).servers.length).toBe(1);
  });

  it("⭐ 名字不合法 / 没命令 → 丢掉（否则工具名会长出奇怪的东西）", () => {
    const got = normalizeMcpConfig({
      servers: [
        { name: "有中文", command: "x" },
        { name: "", command: "x" },
        { name: "ok", command: "" },
        { name: "good", command: "x" },
      ],
    });
    expect(got.servers.map((s) => s.name)).toEqual(["good"]);
    expect(isValidServerName("good")).toBe(true);
    expect(isValidServerName("有中文")).toBe(false);
  });

  it("坏到底的东西兜成空表（不许把界面搞崩）", () => {
    expect(normalizeMcpConfig(null)).toEqual(emptyMcpConfig());
    expect(normalizeMcpConfig("字符串")).toEqual(emptyMcpConfig());
    expect(normalizeMcpConfig({ servers: 42 })).toEqual(emptyMcpConfig());
  });

  it("名字去重、条数有上限", () => {
    const dup = normalizeMcpConfig({ servers: [{ name: "a", command: "x" }, { name: "a", command: "y" }] });
    expect(dup.servers.length).toBe(1);
    const many = normalizeMcpConfig({
      servers: Array.from({ length: MAX_MCP_SERVERS + 3 }, (_, i) => ({ name: `s${i}`, command: "x" })),
    });
    expect(many.servers.length).toBe(MAX_MCP_SERVERS);
  });

  it("`enabled: false` 保留（配了但先别连），其它值不算禁用", () => {
    const got = normalizeMcpConfig({
      servers: [
        { name: "a", command: "x", enabled: false },
        { name: "b", command: "x", enabled: true },
      ],
    });
    expect(got.servers[0].enabled).toBe(false);
    expect(got.servers[1].enabled).toBeUndefined();
    expect(serverUsable(got.servers[0], true)).toBe(false);
    expect(serverUsable(got.servers[1], true)).toBe(true);
    /* 配了但没连上 → 也不可用（别把幽灵工具交给模型） */
    expect(serverUsable(got.servers[1], false)).toBe(false);
  });
});

describe("⭐ 闸门：MCP 工具默认按「写」对待", () => {
  it("「按需确认」档下会被问（这是这条规则的**全部意义**）", () => {
    const name = mcpToolName("files", "delete_everything");
    expect(policyOf(name).kind).toBe("write");
    expect(decide("按需确认", name)).toBe("ask");
  });

  it("「全部允许」档下照跑（那一档的定义就是「用户说他都同意」）", () => {
    expect(decide("全部允许", mcpToolName("x", "y"))).toBe("run");
  });

  it("「每步确认」档下当然也问", () => {
    for (const mode of CONFIRM_MODES) {
      const verdict = decide(mode, mcpToolName("x", "y"));
      expect(mode === "全部允许" ? verdict === "run" : verdict === "ask").toBe(true);
    }
  });

  it("⭐ 这条**故意违反**「未声明默认只读」的便利 —— 而自有工具仍按它走", () => {
    /* 我们自己写的工具仍然默认只读放行（这是 Cline 口径，不能改） */
    expect(policyOf("some_new_tool").kind).toBe("read");
    expect(policyOf("read_file").kind).toBe("read");
    /* 外部来的不享受这个默认 */
    expect(policyOf(mcpToolName("s", "t")).kind).toBe("write");
  });
});

describe("状态那句话", () => {
  it("连上了说清给了几个工具", () => {
    expect(serverStatusLine({ name: "a", command: "x" }, "on", 3)).toContain("3");
  });

  it("未启用 / 失败 / 连接中各有说法（不许一片空白）", () => {
    expect(serverStatusLine({ name: "a", command: "x", enabled: false }, "off", 0)).toBe(MCP_LABELS.status.off);
    expect(serverStatusLine({ name: "a", command: "x" }, "error", 0)).toBe(MCP_LABELS.status.error);
    expect(serverStatusLine({ name: "a", command: "x" }, "starting", 0)).toBe(MCP_LABELS.status.starting);
  });
});
