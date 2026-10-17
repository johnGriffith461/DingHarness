import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  SKILL_BLOCK_CHARS,
  SKILL_DESC_CHARS,
  discoverSkills,
  parseSkillFile,
  pathMatches,
  selectSkills,
  skillPromptBlock,
  type Skill,
} from "./skills";

/**
 * 技能（G08）。
 *
 * 判据：frontmatter 解析不靠 YAML 库也能覆盖我们要的那几个键；
 * 三种触发各自成立；预算超了**如实说**还有几条没展开。
 */

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-skills-"));
  dirs.push(dir);
  return dir;
}

function writeSkill(root: string, id: string, text: string): void {
  fs.mkdirSync(path.join(root, id), { recursive: true });
  fs.writeFileSync(path.join(root, id, "SKILL.md"), text, "utf8");
}

describe("frontmatter 解析", () => {
  it("⭐ 标准形状：键值 + 正文", () => {
    const got = parseSkillFile("---\nname: 发布\ndescription: 发版前检查\ntriggers: 发布, release\n---\n正文第一行\n第二行");
    expect(got.meta.name).toBe("发布");
    expect(got.meta.triggers).toBe("发布, release");
    expect(got.body).toBe("正文第一行\n第二行");
  });

  it("没有 frontmatter 时整份当正文", () => {
    expect(parseSkillFile("就是一篇文章").body).toBe("就是一篇文章");
  });

  it("CRLF 与 BOM 都要认（Windows 上手写的文件很常见）", () => {
    const got = parseSkillFile("\uFEFF---\r\nname: x\r\n---\r\n正文");
    expect(got.meta.name).toBe("x");
    expect(got.body).toBe("正文");
  });
});

describe("发现（discoverSkills）", () => {
  it("⭐ 只认 <目录>/<名字>/SKILL.md；坏文件跳过", () => {
    const root = tempDir();
    writeSkill(root, "release", "---\nname: 发布检查\ndescription: 发版前要跑什么\ntriggers: 发布, release\nalways: false\n---\n先跑 eval");
    writeSkill(root, "bad", "---\nname: 坏的\n---\n（这个也能读，只是没有 description）");
    fs.mkdirSync(path.join(root, "empty"), { recursive: true });
    const skills = discoverSkills(root);
    expect(skills.map((s) => s.id)).toEqual(["bad", "release"]);
    expect(skills[1]).toMatchObject({ name: "发布检查", description: "发版前要跑什么", triggers: ["发布", "release"], always: false });
    /* 没有 description 时用正文第一行兜底（不显示空说明） */
    expect(skills[0]?.description).toBe("（这个也能读，只是没有 description）");
  });

  it("目录不存在 → 空数组（不是错误）", () => {
    expect(discoverSkills(path.join(tempDir(), "nope"))).toEqual([]);
  });

  it("正文超过描述上限时截断（不把整篇塞进提示词）", () => {
    const root = tempDir();
    writeSkill(root, "long", `---\nname: 长\n---\n${"字".repeat(SKILL_DESC_CHARS + 100)}`);
    const [skill] = discoverSkills(root);
    expect(skill!.body.length).toBe(SKILL_DESC_CHARS);
  });
});

describe("路径触发", () => {
  it("`*` 不跨目录、`**` 跨", () => {
    expect(pathMatches("release/*", "release/a.md")).toBe(true);
    expect(pathMatches("release/*", "release/sub/a.md")).toBe(false);
    expect(pathMatches("release/**", "release/sub/a.md")).toBe(true);
  });

  it("反斜杠路径也能匹配（用户在 Windows 上贴的）", () => {
    expect(pathMatches("src/**", "src\\a\\b.ts")).toBe(true);
  });
});

describe("选择（selectSkills）", () => {
  const skill = (over: Partial<Skill>): Skill => ({
    id: "s",
    name: "S",
    description: "d",
    triggers: [],
    paths: [],
    always: false,
    body: "",
    file: "/x/SKILL.md",
    ...over,
  });

  it("⭐ 三种触发：常驻 / 关键词 / 路径", () => {
    const always = skill({ id: "a", always: true });
    const keyword = skill({ id: "k", triggers: ["发布", "release"] });
    const byPath = skill({ id: "p", paths: ["release/**"] });
    const none = skill({ id: "n" });

    expect(selectSkills([always, keyword, byPath, none], { text: "帮我准备发布" }).map((s) => s.id)).toEqual(["a", "k"]);
    expect(selectSkills([always, keyword, byPath, none], { text: "看看这个", files: ["release/notes.md"] }).map((s) => s.id)).toEqual([
      "a",
      "p",
    ]);
    expect(selectSkills([always, keyword, byPath, none], { text: "无关的话" }).map((s) => s.id)).toEqual(["a"]);
  });

  it("大小写不敏感（英文关键词）", () => {
    const s = skill({ triggers: ["Release"] });
    expect(selectSkills([s], { text: "do a release" })).toHaveLength(1);
  });
});

describe("提示词块（skillPromptBlock）", () => {
  const skill = (i: number): Skill => ({
    id: `s${i}`,
    name: `技能${i}`,
    description: "说明".repeat(20),
    triggers: [],
    paths: [],
    always: false,
    body: "",
    file: `/skills/s${i}/SKILL.md`,
  });

  it("空输入给空串（不多出空行）", () => {
    expect(skillPromptBlock([])).toBe("");
  });

  it("⭐ 超预算时如实说还有几条没展开", () => {
    const many = Array.from({ length: 100 }, (_, i) => skill(i));
    const block = skillPromptBlock(many, { limitChars: 400 });
    expect(block).toContain("另有");
    expect(block.length).toBeLessThan(SKILL_BLOCK_CHARS);
  });

  it("每条都带文件路径（模型要读细节时知道去哪读）", () => {
    expect(skillPromptBlock([skill(0)])).toContain("/skills/s0/SKILL.md");
  });
});
