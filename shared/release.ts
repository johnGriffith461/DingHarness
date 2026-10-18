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
