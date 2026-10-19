import { describe, expect, it } from "vitest";

import {
  applyMention,
  detectAtTrigger,
  parseMentionText,
  rankCandidates,
  sensitivePathReason,
  tokenOf,
} from "./mentions";

/**
 * B1：`@` 触发的纯逻辑。
 * 最容易写错的两处：句中的 `@`（邮箱）也弹菜单；代码块里敲 `@` 也弹。
 */

describe("detectAtTrigger", () => {
  it("行首的 @ 命中", () => {
    expect(detectAtTrigger("@src", 4)).toEqual({ start: 0, end: 4, query: "src" });
  });

  it("空白后的 @ 命中", () => {
    expect(detectAtTrigger("看看 @src/foo", 11)).toEqual({ start: 3, end: 11, query: "src/foo" });
  });

  it("⭐ 邮箱里的 @ 不命中", () => {
    expect(detectAtTrigger("a@b.com", 7)).toBeNull();
  });

  it("⭐ 代码块里不命中", () => {
    expect(detectAtTrigger("```ts\nconst x = @foo", 20)).toBeNull();
    expect(detectAtTrigger("```ts\ncode\n```\n@foo", 21)).not.toBeNull();
  });

  it("@@ 与空格后不收", () => {
    expect(detectAtTrigger("@@src", 4)).toBeNull();
    expect(detectAtTrigger("@src foo", 8)).toBeNull();
  });

  it("光标在 @ 之后、但查询词里已有空白 → 不命中", () => {
    expect(detectAtTrigger("@src foo bar", 12)).toBeNull();
  });
});

describe("applyMention / tokenOf", () => {
  it("文件引用替换查询词，光标落在末尾", () => {
    const got = applyMention("看看 @src", { start: 3, end: 7 }, { kind: "file", label: "src/a.ts", path: "src/a.ts" });
    expect(got.text).toBe("看看 @src/a.ts");
    expect(got.caret).toBe(got.text.length);
    expect(got.token).toBe("@src/a.ts");
  });

  it("目录引用带尾斜杠；Windows 反斜杠统一成正斜杠", () => {
    expect(tokenOf({ kind: "dir", label: "x", path: "src\\lib" })).toBe("@src/lib/");
  });

  it("会话与技能用带前缀的标记", () => {
    expect(tokenOf({ kind: "session", label: "t1", sessionId: "s-1" })).toBe("@session:s-1");
    expect(tokenOf({ kind: "skill", label: "review", skillName: "review" })).toBe("@skill:review");
  });
});

describe("parseMentionText", () => {
  it("解析文件、目录、会话、技能", () => {
    const got = parseMentionText("读 @src/a.ts 和目录 @src/lib/ 再看 @session:s-1 与 @skill:review");
    expect(got.map((m) => m.kind)).toEqual(["file", "dir", "session", "skill"]);
    expect(got[0]).toMatchObject({ path: "src/a.ts", label: "src/a.ts" });
    expect(got[1]).toMatchObject({ path: "src/lib" });
    expect(got[2]).toMatchObject({ sessionId: "s-1" });
    expect(got[3]).toMatchObject({ skillName: "review" });
  });

  it("邮箱与没有前缀的普通文本不误判", () => {
    expect(parseMentionText("写信给 a@b.com")).toEqual([]);
  });

  it("句末标点不会吃进路径", () => {
    const got = parseMentionText("看看 @src/a.ts，然后告诉我");
    expect(got[0]?.path).toBe("src/a.ts");
  });
});

describe("敏感文件与候选排序", () => {
  it.each([".env", ".env.local", "certs/server.pem", "id_rsa", "id_ed25519.pub"])("%s 被拒", (file) => {
    expect(sensitivePathReason(file)).toBeTruthy();
  });

  it("普通文件不拒", () => {
    expect(sensitivePathReason("src/a.ts")).toBeNull();
    expect(sensitivePathReason("README.md")).toBeNull();
  });

  it("目录优先、前缀命中优先、最多 20 条", () => {
    const items: Array<{ kind: "file" | "dir"; label: string; path: string }> = Array.from({ length: 25 }, (_, i) => ({
      kind: "file" as const,
      label: i === 24 ? "src/a.ts" : `other/f${i}.ts`,
      path: `C:/repo/${i === 24 ? "src/a.ts" : `other/f${i}.ts`}`,
    }));
    items.push({ kind: "dir", label: "src", path: "C:/repo/src" });

    const got = rankCandidates(items, "src");
    expect(got[0]).toMatchObject({ kind: "dir", label: "src" });
    expect(got[1]).toMatchObject({ label: "src/a.ts" });
    expect(got.length).toBeLessThanOrEqual(20);
  });
});
