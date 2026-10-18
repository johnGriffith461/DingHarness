/**
 * **nightly → stable 晋升的判定**（E02，2026-10-18）。
 *
 * ## 为什么判定单独一份
 *
 * RELEASE.md 写的是纪律（"stable 只从 nightly 晋升、七道门缺一不可"），
 * 而纪律只有在**能拒绝**的时候才算数。这一份是可单测的判定：
 * 版本形状、门禁证据、产物摘要 —— 晋升脚本与守卫都引它，
 * 不各自手写一遍"什么算全绿"。
 *
 * ## 门禁清单与 RELEASE.md 第六条逐字一致
 *
 * 改这张表 = 改发布纪律，必须同时改 RELEASE.md（`shared/release.test.ts` 会对账）。
 */

/** 晋升前必须全绿的门（顺序即 RELEASE.md 里的顺序）。 */
export const PROMOTION_GATES = [
  "pnpm typecheck",
  "pnpm lint",
  "pnpm test",
  "pnpm eval",
  "pnpm bench",
  "pnpm verify:supply-chain",
  "pnpm verify:sdk",
] as const;

export type PromotionGate = (typeof PROMOTION_GATES)[number];

/** 一份 nightly 构建留下的证据（脚本写、晋升读）。 */
export type NightlyEvidence = {
  version: string;
  /** 构建时的提交。晋升必须在同一个提交上（否则"全绿"不是指这一份代码）。 */
  gitSha?: string;
  builtAt?: string;
  gates: Partial<Record<PromotionGate, { ok?: boolean; at?: string; note?: string }>>;
  artifacts?: Array<{ name: string; sha256: string }>;
};

/** 版本解析结果。 */
export type NightlyVersion =
  | { ok: true; base: string; date: string }
  | { ok: false; reason: string };

/**
 * 解析 `X.Y.Z-nightly.YYYYMMDD`。
 *
 * @param version 版本号
 * @returns 基础版本与日期；不是 nightly 形状时说清为什么
 */
export function parseNightlyVersion(version: string): NightlyVersion {
  const text = String(version ?? "").trim();
  const m = /^(\d+\.\d+\.\d+)-nightly\.(\d{8})$/.exec(text);
  if (!m) {
    if (/-nightly\./.test(text)) return { ok: false, reason: `nightly 日期要 8 位（收到 ${text}）` };
    return { ok: false, reason: `不是 nightly 版本（要 X.Y.Z-nightly.YYYYMMDD，收到 ${text || "空"}）` };
  }
  const date = m[2]!;
  const month = Number(date.slice(4, 6));
  const day = Number(date.slice(6, 8));
  if (month < 1 || month > 12 || day < 1 || day > 31) {
    return { ok: false, reason: `nightly 日期不合法：${date}` };
  }
  return { ok: true, base: m[1]!, date };
}

/** 晋升后的 stable 版本（不是 nightly 就给空串）。 */
export function stableFromNightly(version: string): string {
  const parsed = parseNightlyVersion(version);
  return parsed.ok ? parsed.base : "";
}

/** 一次晋升检查的结论。 */
export type PromotionCheck = { ok: true; from: string; to: string } | { ok: false; problems: string[] };

/**
 * 检查一份 nightly 证据能不能晋升。
 *
 * @param evidence nightly 写下的证据
 * @param opts.headSha 当前 HEAD（给了就要求与证据里的 gitSha 一致）
 * @returns 结论；不通过时逐条说清哪道门没过
 */
export function checkPromotion(evidence: NightlyEvidence | null | undefined, opts: { headSha?: string } = {}): PromotionCheck {
  const problems: string[] = [];
  if (!evidence || typeof evidence !== "object") {
    return { ok: false, problems: ["没有 nightly 证据（nightly 构建会写一份 manifest）"] };
  }
  const parsed = parseNightlyVersion(evidence.version);
  if (!parsed.ok) problems.push(parsed.reason);

  for (const gate of PROMOTION_GATES) {
    const got = evidence.gates?.[gate];
    if (!got || got.ok !== true) problems.push(`门没过或没记录：${gate}`);
  }

  if (opts.headSha && evidence.gitSha && evidence.gitSha !== opts.headSha) {
    problems.push(
      `证据来自另一个提交（${evidence.gitSha.slice(0, 12)}），当前 HEAD 是 ${opts.headSha.slice(0, 12)} —— 晋升必须在同一份代码上`,
    );
  }
  if (!evidence.gitSha) problems.push("证据里没有 gitSha（无法确认全绿的是哪一份代码）");

  /* 产物摘要：给了就必须形状对；没给只提醒（有些 nightly 只跑门不打包） */
  if (evidence.artifacts !== undefined) {
    if (!Array.isArray(evidence.artifacts) || evidence.artifacts.length === 0) {
      problems.push("artifacts 字段在，但里面没有产物摘要");
    } else {
      for (const item of evidence.artifacts) {
        if (!item || typeof item.name !== "string" || !/^[a-f0-9]{64}$/i.test(String(item.sha256 ?? ""))) {
          problems.push(`产物摘要形状不对：${JSON.stringify(item)?.slice(0, 80)}`);
        }
      }
    }
  }

  if (problems.length) return { ok: false, problems };
  return { ok: true, from: evidence.version, to: parsed.ok ? parsed.base : "" };
}

/* ─────────────────── 发版前的机械核对（E01 的准备，不发布） ─────────────────── */

/** 一份版本文件（路径 + 里面写的版本）。 */
export type VersionFile = { file: string; version: string };

/** 一次版本一致性核对。 */
export type VersionCheck = { ok: true; version: string } | { ok: false; problems: string[] };

/**
 * 核对几份版本号文件是否一致、形状是否符合这次要发的轨道。
 *
 * @param files 版本文件（`shared/version.json` / `package.json` / `packages/cli/package.json`）
 * @param mode `stable` = 不许预发布后缀；`nightly` = 必须是 nightly 形状；`any` = 只要一致
 */
export function checkVersionSet(files: readonly VersionFile[], mode: "stable" | "nightly" | "any" = "any"): VersionCheck {
  const problems: string[] = [];
  if (!files.length) return { ok: false, problems: ["没有任何版本文件"] };

  for (const item of files) {
    if (!item.version || !/^\d+\.\d+\.\d+/.test(item.version.trim())) {
      problems.push(`${item.file} 的版本不是 X.Y.Z：${JSON.stringify(item.version)}`);
    }
  }
  const versions = new Set(files.map((f) => f.version.trim()));
  if (versions.size > 1) {
    problems.push(`版本号不一致：${files.map((f) => `${f.file}=${f.version}`).join(" / ")}`);
  }
  const version = files[0]!.version.trim();
  if (mode === "stable" && version.includes("-")) {
    problems.push(`stable 发布不能带预发布后缀（收到 ${version}）`);
  }
  if (mode === "nightly") {
    const parsed = parseNightlyVersion(version);
    if (!parsed.ok) problems.push(parsed.reason);
  }
  return problems.length ? { ok: false, problems } : { ok: true, version };
}

/**
 * CHANGELOG 的发布段是否就绪。
 *
 * 口径（Keep a Changelog + 本仓习惯）：**最上面那个二级标题**要么是 `## 未发布`（还没发），
 * 要么是 `## X.Y.Z`（已发）。发版时把「未发布」改成版本号 + 日期 —— 写在这里，
 * 是因为"忘了改标题"是最常见的漏项，而它没人会红。
 *
 * @param changelog CHANGELOG.md 全文
 * @param version 这次要发的版本（给了就要求标题里出现它，或仍是「未发布」）
 */
export function checkChangelogHeading(changelog: string, version?: string): { ok: boolean; heading: string; problem?: string } {
  const heading = /^##\s+(.+)$/m.exec(changelog)?.[1]?.trim() ?? "";
  if (!heading) return { ok: false, heading: "", problem: "CHANGELOG.md 里没有二级标题（找不到发布段）" };
  if (heading.startsWith("未发布")) return { ok: true, heading };
  if (!version) return { ok: true, heading };
  if (heading.includes(version)) return { ok: true, heading };
  return {
    ok: false,
    heading,
    problem: `CHANGELOG 最上面的发布段是「${heading}」，既不是「未发布」也不含 ${version} —— 发版前要把标题改成版本号 + 日期`,
  };
}

/* ─────────────────── CHANGELOG 草稿（D09：从提交生成，人工定稿） ─────────────────── */

/** 一条提交（只要生成草稿需要的两个字段）。 */
export type CommitLine = { sha: string; subject: string };

/** 一组提交（按任务号）。 */
export type CommitGroup = { task: string; commits: CommitLine[] };

/**
 * 从提交标题里认出**任务号**（本仓习惯：`G12 IM 审批卡…`、`L06 个性化…`、`U03 …`、`E02 …`）。
 *
 * 认不出就归到「其他」—— **不猜**（猜错的分类比不分更难查）。
 * 支持带连字符的（`V6-2n`）与 `Phase 0` 这种写法。
 *
 * @param subject 提交标题
 * @returns 任务号；认不出返回空串
 */
export function taskOfCommit(subject: string): string {
  const text = String(subject ?? "").trim();
  const m = /^(?:([A-Z]\d{1,2}(?:-\d+[a-z]?)?)\b|(Phase\s+\d+)\b)/.exec(text);
  return (m?.[1] ?? m?.[2] ?? "").trim();
}

/**
 * 把提交按任务号分组（组顺序 = 第一次出现的顺序；组内保持原顺序）。
 *
 * @param commits 提交（新在前或旧在前都行 —— 这里不改顺序）
 */
export function groupCommits(commits: readonly CommitLine[]): CommitGroup[] {
  const groups: CommitGroup[] = [];
  const index = new Map<string, CommitGroup>();
  for (const commit of commits) {
    const task = taskOfCommit(commit.subject) || "其他";
    let group = index.get(task);
    if (!group) {
      group = { task, commits: [] };
      index.set(task, group);
      groups.push(group);
    }
    group.commits.push(commit);
  }
  return groups;
}

/**
 * 生成 CHANGELOG 草稿（Markdown）。
 *
 * ⚠️ **它是草稿，不是发布记录**：条目是提交标题原文，没有经过"用户可见差异"的改写。
 * 发版时仍要按 `RELEASE.md` 第四条人工过一遍（Keep a Changelog 口径）。
 *
 * @param groups 分组结果
 * @param opts.version 版本号（写进标题；没给就用「未发布」）
 * @param opts.date 日期（`YYYY-MM-DD`）
 */
export function changelogDraft(groups: readonly CommitGroup[], opts: { version?: string; date?: string } = {}): string {
  const heading = opts.version ? `## ${opts.version}${opts.date ? `（${opts.date}）` : ""}` : "## 未发布";
  const lines: string[] = [heading, "", "> 草稿：条目来自提交标题，发版前要按「用户可见差异」改写。", ""];
  for (const group of groups) {
    lines.push(`### ${group.task}`, "");
    for (const commit of group.commits) {
      lines.push(`- ${commit.subject}（${commit.sha.slice(0, 7)}）`);
    }
    lines.push("");
  }
  return lines.join("\n").trimEnd() + "\n";
}
