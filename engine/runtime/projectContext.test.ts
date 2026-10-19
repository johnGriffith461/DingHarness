import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  clearProjectContextCache,
  findGitRoot,
  loadProjectContext,
  renderProjectContext,
  withProjectContext,
} from "./projectContext";

/**
 * A1/A2：项目规则与环境注入。
 *
 * 这些断言守的是"模型第一轮就能知道自己在哪"——不是"我们造了个函数"。
 * 最容易假绿的两处：空规则也渲染出一个空标题；缓存永远不失效。
 */

let dir: string;

beforeEach(() => {
  clearProjectContextCache();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "ding-project-context-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function write(rel: string, text: string): string {
  const file = path.join(dir, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, "utf8");
  return file;
}

describe("A1 规则加载", () => {
  it("子目录 cwd 也能读到仓库根的 AGENTS.md", () => {
    write(".git", "");
    write("AGENTS.md", "测试命令是 pnpm test。");
    const sub = path.join(dir, "src", "deep");
    fs.mkdirSync(sub, { recursive: true });

    const ctx = loadProjectContext(sub);

    expect(ctx.gitRoot?.toLowerCase()).toBe(dir.toLowerCase());
    expect(ctx.rules).toHaveLength(1);
    expect(ctx.rules[0].path.toLowerCase()).toBe(path.join(dir, "AGENTS.md").toLowerCase());
    expect(ctx.ruleText).toContain("pnpm test");
    expect(renderProjectContext(ctx)).toContain("<project_instructions>");
  });

  it("同层 AGENTS.md 优先于 CLAUDE.md，且只收第一个", () => {
    write(".git", "");
    write("AGENTS.md", "来自 AGENTS");
    write("CLAUDE.md", "来自 CLAUDE");

    const ctx = loadProjectContext(dir);

    expect(ctx.rules).toHaveLength(1);
    expect(ctx.ruleText).toContain("来自 AGENTS");
    expect(ctx.ruleText).not.toContain("来自 CLAUDE");
  });

  it("AGENTS.override.md 压过同层其它两个", () => {
    write(".git", "");
    write("AGENTS.override.md", "来自 override");
    write("AGENTS.md", "来自 AGENTS");
    write("CLAUDE.md", "来自 CLAUDE");

    const ctx = loadProjectContext(dir);

    expect(ctx.ruleText).toContain("来自 override");
    expect(ctx.ruleText).not.toContain("来自 AGENTS");
  });

  it("没有规则文件时不产生空块标题", () => {
    write(".git", "");
    const ctx = loadProjectContext(dir);

    expect(ctx.ruleText).toBe("");
    const rendered = renderProjectContext(ctx);
    expect(rendered).not.toContain("<project_instructions>");
    expect(rendered).toContain("<environment>");
    expect(withProjectContext("原系统提示", "")).toBe("原系统提示");
  });

  it("超过 32 KiB 会被截断并写明截了多少字节", () => {
    write(".git", "");
    write("AGENTS.md", "a".repeat(40 * 1024));

    const ctx = loadProjectContext(dir);

    expect(ctx.truncated).toBe(true);
    expect(ctx.rules[0].bytes).toBe(40 * 1024);
    expect(ctx.ruleText).toContain(`已截断 ${8 * 1024} 字节`);
    expect(Buffer.byteLength(ctx.ruleText, "utf8")).toBeLessThan(33 * 1024);
  });

  it("文件改了之后下一次调用读到新内容（缓存按 mtime + 大小失效）", async () => {
    write(".git", "");
    const file = write("AGENTS.md", "旧规则 v1");
    expect(loadProjectContext(dir).ruleText).toContain("旧规则 v1");

    await new Promise((r) => setTimeout(r, 20));
    fs.writeFileSync(file, "新规则 v2（更长一点）", "utf8");

    expect(loadProjectContext(dir).ruleText).toContain("新规则 v2");
    expect(loadProjectContext(dir).ruleText).not.toContain("旧规则 v1");
  });

  it("全局目录的规则排在工作区规则前面并标注来源", () => {
    write(".git", "");
    write("AGENTS.md", "工作区规则");
    const globalDir = path.join(dir, "global");
    fs.mkdirSync(globalDir, { recursive: true });
    fs.writeFileSync(path.join(globalDir, "AGENTS.md"), "全局规则", "utf8");

    const ctx = loadProjectContext(dir, { globalDir });

    expect(ctx.rules.map((r) => r.source)).toEqual(["global", "workspace"]);
    expect(ctx.ruleText.indexOf("全局规则")).toBeLessThan(ctx.ruleText.indexOf("工作区规则"));
    expect(ctx.ruleText).toContain("（全局）");
  });

  it("无 git 时 gitRoot 为空，只搜 cwd", () => {
    write("AGENTS.md", "当前目录规则");
    const parent = path.dirname(dir);
    expect(findGitRoot(dir)).toBeUndefined();

    const ctx = loadProjectContext(dir);
    expect(ctx.gitRoot).toBeUndefined();
    expect(ctx.ruleText).toContain("当前目录规则");
    expect(parent).not.toBe(dir);
  });
});

describe("A2 环境事实", () => {
  it.each([
    ["pnpm-lock.yaml", "pnpm"],
    ["package-lock.json", "npm"],
    ["yarn.lock", "yarn"],
    ["bun.lockb", "bun"],
  ] as const)("%s → %s", (lock, manager) => {
    write(lock, "");
    write("package.json", JSON.stringify({ scripts: { test: "vitest" } }));

    const ctx = loadProjectContext(dir);

    expect(ctx.packageManager).toBe(manager);
    expect(ctx.testCommand).toBe(`${manager} test`);
    expect(renderProjectContext(ctx)).toContain(`package_manager: ${manager}`);
    expect(renderProjectContext(ctx)).toContain(`test_command: ${manager} test`);
  });

  it("没有 scripts.test 时不输出 test_command（不猜 pytest/make）", () => {
    write("pnpm-lock.yaml", "");
    write("package.json", JSON.stringify({ scripts: { build: "tsc" } }));

    const ctx = loadProjectContext(dir);

    expect(ctx.testCommand).toBeUndefined();
    const rendered = renderProjectContext(ctx);
    expect(rendered).not.toContain("test_command");
    expect(rendered).toContain("package_manager: pnpm");
  });

  it("package.json 损坏不影响规则加载", () => {
    write(".git", "");
    write("AGENTS.md", "规则还在");
    write("package.json", "{ 这不是 JSON");

    const ctx = loadProjectContext(dir);

    expect(ctx.ruleText).toContain("规则还在");
    expect(ctx.testCommand).toBeUndefined();
  });

  it("environment 里带 cwd / platform / git_root", () => {
    write(".git", "");
    const ctx = loadProjectContext(dir, { platform: "win32" });
    const rendered = renderProjectContext(ctx);

    expect(rendered).toContain(`cwd: ${path.resolve(dir)}`);
    expect(rendered).toContain("platform: win32");
    expect(rendered).toContain(`git_root: ${path.resolve(dir)}`);
  });

  it("withProjectContext 把项目块放在系统提示词之前", () => {
    write(".git", "");
    write("AGENTS.md", "规则正文");
    const rendered = renderProjectContext(loadProjectContext(dir));

    const joined = withProjectContext("你是编码 agent", rendered);

    expect(joined.startsWith("<project_instructions>")).toBe(true);
    expect(joined.endsWith("你是编码 agent")).toBe(true);
  });
});
