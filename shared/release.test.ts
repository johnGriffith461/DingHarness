import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  PROMOTION_GATES,
  checkChangelogHeading,
  checkPromotion,
  checkVersionSet,
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
