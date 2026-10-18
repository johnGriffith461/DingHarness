import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  PROMOTION_GATES,
  checkChangelogHeading,
  checkPromotion,
  checkVersionSet,
  changelogDraft,
  groupCommits,
  taskOfCommit,
  parseNightlyVersion,
  stableFromNightly,
  type NightlyEvidence,
} from "./release";

/**
 * **E02 nightly→stable 晋升判定**的判据。
 *
 * 这里钉的是"能不能拒绝"：形状不对、门没全绿、证据来自另一个提交 ——
 * 三种都必须被挡，而不是靠人记得。门禁清单与 RELEASE.md 对账。
 */

const allGatesOk = () =>
  Object.fromEntries(PROMOTION_GATES.map((g) => [g, { ok: true, at: "2026-10-18T00:00:00Z" }]));

const evidence = (over: Partial<NightlyEvidence> = {}): NightlyEvidence => ({
  version: "0.5.2-nightly.20261018",
  gitSha: "a".repeat(40),
  gates: allGatesOk(),
  ...over,
});

describe("版本形状", () => {
  it("认 X.Y.Z-nightly.YYYYMMDD", () => {
    expect(parseNightlyVersion("0.5.2-nightly.20261018")).toEqual({ ok: true, base: "0.5.2", date: "20261018" });
    expect(stableFromNightly("0.5.2-nightly.20261018")).toBe("0.5.2");
  });

  it("stable 版本不是 nightly（不能拿 stable 再晋升一次）", () => {
    expect(parseNightlyVersion("0.5.2").ok).toBe(false);
    expect(stableFromNightly("0.5.2")).toBe("");
  });

  it("日期必须是 8 位且合法", () => {
    expect(parseNightlyVersion("0.5.2-nightly.2026").ok).toBe(false);
    expect(parseNightlyVersion("0.5.2-nightly.20261340").ok).toBe(false);
  });
});

describe("晋升检查", () => {
  it("七道门全绿 + 同一提交 → 通过，目标是不带后缀的版本", () => {
    expect(checkPromotion(evidence(), { headSha: "a".repeat(40) })).toEqual({
      ok: true,
      from: "0.5.2-nightly.20261018",
      to: "0.5.2",
    });
  });

  it("缺一道门 → 拒绝，并点名是哪一道", () => {
    const gates = allGatesOk();
    delete (gates as Record<string, unknown>)["pnpm bench"];
    const got = checkPromotion(evidence({ gates }));
    expect(got.ok).toBe(false);
    if (!got.ok) expect(got.problems.join("\n")).toContain("pnpm bench");
  });

  it("门记了但 ok=false → 拒绝", () => {
    const gates = { ...allGatesOk(), "pnpm eval": { ok: false } };
    const got = checkPromotion(evidence({ gates }));
    expect(got.ok).toBe(false);
    if (!got.ok) expect(got.problems.join("\n")).toContain("pnpm eval");
  });

  it("证据来自另一个提交 → 拒绝（全绿的不是这份代码）", () => {
    const got = checkPromotion(evidence({ gitSha: "b".repeat(40) }), { headSha: "a".repeat(40) });
    expect(got.ok).toBe(false);
    if (!got.ok) expect(got.problems.join("\n")).toContain("另一个提交");
  });

  it("没有 gitSha → 拒绝", () => {
    const got = checkPromotion(evidence({ gitSha: undefined }));
    expect(got.ok).toBe(false);
    if (!got.ok) expect(got.problems.join("\n")).toContain("gitSha");
  });

  it("产物摘要形状不对 → 拒绝", () => {
    const got = checkPromotion(evidence({ artifacts: [{ name: "cli.tgz", sha256: "abc" }] }));
    expect(got.ok).toBe(false);
    if (!got.ok) expect(got.problems.join("\n")).toContain("产物摘要");
  });

  it("没有证据文件 → 拒绝", () => {
    expect(checkPromotion(null).ok).toBe(false);
  });

  it("门禁清单与 RELEASE.md 第六条对账", () => {
    const doc = readFileSync(path.resolve(__dirname, "..", "RELEASE.md"), "utf8");
    for (const gate of PROMOTION_GATES) {
      expect(doc, `RELEASE.md 里没有这道门：${gate}`).toContain(gate);
    }
  });
});

/** E01 准备：发版前的机械核对（版本一致 + 轨道形状 + CHANGELOG 标题）。 */
describe("checkVersionSet", () => {
  it("三份一致 → 通过", () => {
    expect(
      checkVersionSet([
        { file: "shared/version.json", version: "0.6.0" },
        { file: "package.json", version: "0.6.0" },
        { file: "packages/cli/package.json", version: "0.6.0" },
      ]),
    ).toEqual({ ok: true, version: "0.6.0" });
  });

  it("不一致 → 点名（这是最容易漂的地方）", () => {
    const got = checkVersionSet([
      { file: "shared/version.json", version: "0.6.0" },
      { file: "package.json", version: "0.5.1" },
    ]);
    expect(got.ok).toBe(false);
    if (!got.ok) expect(got.problems.join("\n")).toContain("不一致");
  });

  it("stable 不许带预发布后缀；nightly 必须是 nightly 形状", () => {
    const nightly = [{ file: "package.json", version: "0.6.0-nightly.20261018" }];
    expect(checkVersionSet(nightly, "stable").ok).toBe(false);
    expect(checkVersionSet(nightly, "nightly").ok).toBe(true);
    expect(checkVersionSet([{ file: "package.json", version: "0.6.0" }], "nightly").ok).toBe(false);
  });

  it("形状不对（缺位）→ 拒绝", () => {
    expect(checkVersionSet([{ file: "package.json", version: "1.2" }]).ok).toBe(false);
  });
});

describe("checkChangelogHeading", () => {
  const doc = (heading: string) => `# 变更记录\n\n${heading}\n\n- 一条改动\n`;

  it("「未发布」永远算就绪（还没发）", () => {
    expect(checkChangelogHeading(doc("## 未发布"), "0.6.0")).toEqual({ ok: true, heading: "未发布" });
  });

  it("标题含这次版本 → 就绪", () => {
    expect(checkChangelogHeading(doc("## 0.6.0（2026-10-20）"), "0.6.0").ok).toBe(true);
  });

  it("标题还是旧版本 → 说清该怎么改", () => {
    const got = checkChangelogHeading(doc("## 0.5.1（2026-10-18）"), "0.6.0");
    expect(got.ok).toBe(false);
    expect(got.problem).toContain("0.6.0");
  });

  it("没有二级标题 → 不假装就绪", () => {
    expect(checkChangelogHeading("# 只有一级标题\n").ok).toBe(false);
  });
});

/** D09：CHANGELOG 草稿（按任务号分组；认不出归「其他」，不猜）。 */
describe("groupCommits / changelogDraft", () => {
  it("认得出 G12 / L06 / U03 / E02 / V6-2n / Phase 0", () => {
    expect(taskOfCommit("G12 IM 审批卡接线：手机上 yes 能批")).toBe("G12");
    expect(taskOfCommit("L06 个性化：主题/快捷键/人格")).toBe("L06");
    expect(taskOfCommit("U03 权限规则 v1")).toBe("U03");
    expect(taskOfCommit("E02 nightly→stable")).toBe("E02");
    expect(taskOfCommit("V6-2n Computer Use")).toBe("V6-2n");
    expect(taskOfCommit("Phase 0 交付门")).toBe("Phase 0");
  });

  it("认不出的归「其他」（不硬塞一个像的任务号）", () => {
    expect(taskOfCommit("跨平台：Linux 全量测试跑通")).toBe("");
    const groups = groupCommits([
      { sha: "a".repeat(40), subject: "跨平台：Linux 全量测试跑通" },
      { sha: "b".repeat(40), subject: "G12 IM 审批卡" },
    ]);
    expect(groups.map((g) => g.task)).toEqual(["其他", "G12"]);
  });

  it("组内保持原顺序、组按首次出现排序", () => {
    const groups = groupCommits([
      { sha: "1".repeat(40), subject: "G12 第一条" },
      { sha: "2".repeat(40), subject: "L06 第一条" },
      { sha: "3".repeat(40), subject: "G12 第二条" },
    ]);
    expect(groups.map((g) => g.task)).toEqual(["G12", "L06"]);
    expect(groups[0]!.commits.map((c) => c.subject)).toEqual(["G12 第一条", "G12 第二条"]);
  });

  it("草稿带标题、说明与短 sha；没给版本写「未发布」", () => {
    const draft = changelogDraft(groupCommits([{ sha: "abcdef1234567890", subject: "G12 接线" }]), { date: "2026-10-18" });
    expect(draft).toContain("## 未发布");
    expect(draft).toContain("### G12");
    expect(draft).toContain("G12 接线（abcdef1）");
    expect(draft).toContain("发版前要按「用户可见差异」改写");
  });

  it("给了版本与日期 → 标题是版本号 + 日期", () => {
    const draft = changelogDraft([], { version: "0.6.0", date: "2026-10-20" });
    expect(draft).toContain("## 0.6.0（2026-10-20）");
  });
});
