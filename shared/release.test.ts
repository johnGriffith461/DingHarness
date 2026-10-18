import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  PROMOTION_GATES,
  checkPromotion,
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
