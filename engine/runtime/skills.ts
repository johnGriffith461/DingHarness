import fs from "node:fs";
import path from "node:path";

/**
 * **技能**（G08，2026-10-18）。
 *
 * ## 它解决什么
 *
 * 同一个项目里，"怎么改这个仓库的测试""发布前要跑哪几条"这类工作方法是**稳定**的，
 * 但每次都要重新解释一遍。技能就是把这些方法写成文件，按需注入提示词。
 *
 * ## 形态（与 Agent Skills 兼容）
 *
 * ```
 * <技能目录>/<名字>/SKILL.md
 * ---
 * name: release-checklist
 * description: 发布前要跑的检查
 * triggers: 发布, release, 上线
 * paths: release/**, package.json
 * always: false
 * ---
 * （正文：给模型看的说明，最多 250 字进提示词；再长就只给路径）
 * ```
 *
 * ## 三种触发（方案 §6.3 G08）
 *
 * 1. **常驻**（`always: true`）：每轮都带（慎用 —— 它是永久占位）；
 * 2. **关键词**：用户这句话里出现 `triggers` 里的词；
 * 3. **路径**：这一轮提到/改到 `paths` 匹配的文件（由调用方给"这一轮碰到的路径"）。
 *
 * ## 预算（防"技能把上下文吃光"）
 *
 * - 每条描述最多 `SKILL_DESC_CHARS`（250）字；
 * - 一次最多注入 `SKILL_BLOCK_CHARS`（8000）字，超了如实说"还有几条没展开"。
 */

/** 技能目录名（`<dataDir>/skills`）。 */
export const SKILLS_DIR = "skills";

/** 一条技能。 */
export type Skill = {
  /** 目录名（唯一键；frontmatter 里的 name 只作显示）。 */
  id: string;
  name: string;
  description: string;
  /** 关键词触发。 */
  triggers: string[];
  /** 路径 glob 触发（`release/**` 这类）。 */
  paths: string[];
  /** 是否每轮都带。 */
  always: boolean;
  /** 正文（进提示词的那一段，已按上限截断）。 */
  body: string;
  /** `SKILL.md` 的绝对路径（模型要读全文时用）。 */
  file: string;
};

/** 每条描述进提示词的字数上限。 */
export const SKILL_DESC_CHARS = 250;

/** 一次性注入的总字数上限。 */
export const SKILL_BLOCK_CHARS = 8_000;

/**
 * 解析 frontmatter（只支持 `key: value` 与逗号分隔的列表，**不引 YAML 库**）。
 *
 * @param text 文件全文
 * @returns 键值对与正文
 */
export function parseSkillFile(text: string): { meta: Record<string, string>; body: string } {
  const normalized = String(text ?? "").replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---\n")) return { meta: {}, body: normalized.trim() };
  const end = normalized.indexOf("\n---", 4);
  if (end < 0) return { meta: {}, body: normalized.trim() };
  const head = normalized.slice(4, end);
  const body = normalized.slice(end + 4).replace(/^\n+/, "").trim();
  const meta: Record<string, string> = {};
  for (const line of head.split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const at = t.indexOf(":");
    if (at <= 0) continue;
    meta[t.slice(0, at).trim()] = t.slice(at + 1).trim();
  }
  return { meta, body };
}

/** 逗号分隔的列表 → 数组（去空、去重）。 */
function listOf(raw: string | undefined): string[] {
  if (!raw) return [];
  return [...new Set(raw.split(/[,，]/).map((x) => x.trim()).filter(Boolean))];
}

/**
 * 从磁盘发现技能。
 *
 * 只认 `<dir>/<技能名>/SKILL.md`（与 Agent Skills 的目录结构一致）；
 * 坏文件跳过（不因为一个手滑的技能让整轮起不来）。
 *
 * @param dir 技能根目录
 * @returns 技能（按目录名排序）
 */
export function discoverSkills(dir: string): Skill[] {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const out: Skill[] = [];
  for (const id of names.sort()) {
    const file = path.join(dir, id, "SKILL.md");
    let text: string;
    try {
      text = fs.readFileSync(file, "utf8");
    } catch {
      continue;
    }
    const { meta, body } = parseSkillFile(text);
    out.push({
      id,
      name: meta.name?.trim() || id,
      description: (meta.description ?? "").trim() || body.split("\n")[0]?.trim() || id,
      triggers: listOf(meta.triggers),
      paths: listOf(meta.paths),
      always: meta.always === "true",
      body: body.slice(0, SKILL_DESC_CHARS),
      file,
    });
  }
  return out;
}

/** glob → 正则（只支持 `*` / `**`，与权限规则同一口径，不引入第二种语义）。 */
export function pathMatches(glob: string, file: string): boolean {
  let out = "^";
  for (let i = 0; i < glob.length; i += 1) {
    const ch = glob[i]!;
    if (ch === "*") {
      if (glob[i + 1] === "*") {
        out += ".*";
        i += 1;
        if (glob[i + 1] === "/") {
          out += "/?";
          i += 1;
        }
      } else {
        out += "[^/\\\\]*";
      }
      continue;
    }
    out += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`${out}$`).test(file.replace(/\\/g, "/"));
}

/**
 * 这一轮该带哪些技能。
 *
 * @param skills 全部技能
 * @param input.text 用户这一轮说的话
 * @param input.files 这一轮碰到的路径（可空）
 */
export function selectSkills(
  skills: readonly Skill[],
  input: { text: string; files?: readonly string[] },
): Skill[] {
  const text = String(input.text ?? "").toLowerCase();
  const files = (input.files ?? []).map((f) => f.replace(/\\/g, "/"));
  return skills.filter((skill) => {
    if (skill.always) return true;
    if (skill.triggers.some((t) => t && text.includes(t.toLowerCase()))) return true;
    if (files.length && skill.paths.some((p) => files.some((f) => pathMatches(p, f)))) return true;
    return false;
  });
}

/**
 * 选中的技能 → 一段提示词。
 *
 * @param skills 选中的技能
 * @param opts.limitChars 总字数上限
 */
export function skillPromptBlock(skills: readonly Skill[], opts: { limitChars?: number } = {}): string {
  if (!skills.length) return "";
  const limit = opts.limitChars ?? SKILL_BLOCK_CHARS;
  const head = "【技能】以下是这个项目里已经写好的工作方法（按需照做；细节用 read_file 读对应文件）：";
  const lines: string[] = [];
  let used = head.length;
  let dropped = 0;
  for (const skill of skills) {
    const line = `- ${skill.name}：${skill.description}（${skill.file}）`;
    if (lines.length > 0 && used + line.length > limit) {
      dropped += 1;
      continue;
    }
    lines.push(line);
    used += line.length + 1;
  }
  const more = dropped ? `\n（另有 ${dropped} 条技能未展开：本次注入上限 ${limit} 字）` : "";
  return `${head}\n${lines.join("\n")}${more}`;
}
