/**
 * `@` 引用（B1）：文件 / 目录 / 会话 / 技能 / 动作。
 *
 * 形状照 cc-haha `MentionComposer.tsx` + `ComposerReferenceMenu.tsx` 的
 * trigger/filter/insert（只借设计）：`@` 前面必须是行首或空白，`@` 与光标之间
 * 不能有空白，否则 `a@b.com` 这种输入也会弹菜单。
 *
 * 插入文本保持**人类可读、可继续编辑**：
 *   - 文件/目录：`@src-example.ts`、`@lib-example/`
 *   - 会话：`@session:<id>`
 *   - 技能：`@skill:<name>`
 *
 * 提交时由 `parseMentionText` 从正文里重新解析 —— 用户删掉那段文字，
 * 附件就自然不再带上，不需要另造一套"删除同步"逻辑。
 */

export type MentionKind = "file" | "dir" | "session" | "skill" | "action";

export type Mention = {
  kind: MentionKind;
  label: string;
  path?: string;
  sessionId?: string;
  skillName?: string;
  start: number;
  end: number;
};

export type AtTrigger = {
  /** `@` 在正文里的下标。 */
  start: number;
  /** 光标位置（替换到哪儿）。 */
  end: number;
  /** `@` 后面已经敲的字。 */
  query: string;
};

/**
 * 光标处是不是正在 `@` 唤起。
 *
 * 与 `shared/phrases.ts` 的同名函数同一套规矩，但这里多返回 `end`，
 * 并且**代码块内不触发**：在三反引号围栏里敲 `@` 是写代码，不是引用文件。
 */
export function detectAtTrigger(text: string, caret: number): AtTrigger | null {
  const src = String(text ?? "");
  const pos = Math.max(0, Math.min(caret, src.length));
  /* 代码围栏里敲 `@` 是写代码，不是引用文件：数一下光标前有几个 ``` */
  if (((src.slice(0, pos).match(/```/g) ?? []).length) % 2 === 1) return null;

  const from = Math.max(0, pos - 64);
  for (let i = pos - 1; i >= from; i -= 1) {
    const ch = src[i] ?? "";
    if (ch === "@") {
      const before = i === 0 ? "" : (src[i - 1] ?? "");
      if (before && !/\s/.test(before)) return null;
      return { start: i, end: pos, query: src.slice(i + 1, pos) };
    }
    if (/\s/.test(ch)) return null;
  }
  return null;
}

/** 选中一条引用：把 `@查询词` 换掉，光标落到末尾。 */
export function applyMention(
  text: string,
  trigger: { start: number; end: number },
  mention: Pick<Mention, "kind" | "label" | "path" | "sessionId" | "skillName">,
): { text: string; caret: number; token: string } {
  const src = String(text ?? "");
  const inserted = tokenOf(mention);
  const before = src.slice(0, trigger.start);
  const after = src.slice(trigger.end);
  return { text: before + inserted + after, caret: before.length + inserted.length, token: inserted };
}

/** 一条引用在正文里的写法。 */
export function tokenOf(mention: Pick<Mention, "kind" | "label" | "path" | "sessionId" | "skillName">): string {
  if (mention.kind === "session") return `@session:${mention.sessionId ?? mention.label}`;
  if (mention.kind === "skill") return `@skill:${mention.skillName ?? mention.label}`;
  if (mention.kind === "dir") return `@${(mention.path ?? mention.label).replace(/\\/g, "/").replace(/\/?$/, "/")}`;
  if (mention.kind === "file") return `@${(mention.path ?? mention.label).replace(/\\/g, "/")}`;
  return mention.label;
}

/**
 * 从正文里解析出所有引用（提交时用）。
 * 只认行首/空白后的 `@token`；`a@b.com` 不算。
 */
export function parseMentionText(text: string): Mention[] {
  const src = String(text ?? "");
  const out: Mention[] = [];
  const re = /(^|[\s(（])@([^\s，。；：、,;!?！？()（）]+)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(src)) !== null) {
    const prefix = match[1] ?? "";
    const token = match[2] ?? "";
    if (!token) continue;
    const start = match.index + prefix.length;
    const end = start + 1 + token.length;
    if (token.startsWith("session:")) {
      out.push({ kind: "session", label: token.slice("session:".length), sessionId: token.slice("session:".length), start, end });
      continue;
    }
    if (token.startsWith("skill:")) {
      out.push({ kind: "skill", label: token.slice("skill:".length), skillName: token.slice("skill:".length), start, end });
      continue;
    }
    /* 去掉句末标点（"看看 @app.ts，然后…"） */
    const clean = token.replace(/[，。；：、,.;:!?！？]+$/, "");
    if (!clean) continue;
    if (clean.endsWith("/")) out.push({ kind: "dir", label: clean.slice(0, -1), path: clean.slice(0, -1), start, end });
    else out.push({ kind: "file", label: clean, path: clean, start, end });
  }
  return out;
}

/**
 * 敏感文件默认拒绝（`.env*` / `*.pem` / `id_rsa*`）。
 * 返回拒绝原因；不敏感返回 null。
 */
export function sensitivePathReason(file: string): string | null {
  const base = String(file ?? "").replace(/\\/g, "/").split("/").pop() ?? "";
  if (!base) return null;
  if (base === ".env" || base.startsWith(".env.")) return "环境变量文件默认不引用（可能含密钥）";
  if (/\.pem$/i.test(base) || /^id_(rsa|ed25519|ecdsa)/i.test(base)) return "私钥文件默认不引用";
  return null;
}

/** 文件/目录候选（宿主读盘，这里只做形状与排序）。 */
export type MentionCandidate = {
  kind: "file" | "dir";
  /** 展示名（相对路径）。 */
  label: string;
  /** 绝对路径。 */
  path: string;
};

/** 目录优先、短路径优先；最多 20 条。 */
export function rankCandidates(items: readonly MentionCandidate[], query: string, limit = 20): MentionCandidate[] {
  const q = String(query ?? "").toLowerCase();
  return [...items]
    .filter((item) => !sensitivePathReason(item.path))
    .filter((item) => !q || item.label.toLowerCase().includes(q))
    .sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === "dir" ? -1 : 1;
      const qa = a.label.toLowerCase().startsWith(q) ? 0 : 1;
      const qb = b.label.toLowerCase().startsWith(q) ? 0 : 1;
      if (qa !== qb) return qa - qb;
      return a.label.length - b.label.length || a.label.localeCompare(b.label);
    })
    .slice(0, limit);
}
