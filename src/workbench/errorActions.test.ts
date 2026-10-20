import { describe, expect, it } from "vitest";

import { diagnoseRoute } from "@shared/routeDiagnosis";

/**
 * F-03：三种"走不通"的诊断各给**不同的**下一步（2026-10-20）。
 *
 * 这条测试防的是"三种状态又合并回同一句话"：`action.label` 必须两两不同，
 * 而且都指向设置·模型页（那里既有 key 输入也有模型清单 —— 今天唯一能解决它们的地方）。
 */

const provider = (id: string, available: boolean, models: string[]) => ({ id, label: id, available, models });

describe("诊断 → 动作", () => {
  it("⭐ 无 key / 无模型 / 钉住掉线 三种动作两两不同", () => {
    const noKey = diagnoseRoute({ providers: [provider("p", false, ["m"])] });
    const noModel = diagnoseRoute({ providers: [provider("p", true, [])] });
    const dead = diagnoseRoute({
      providers: [provider("p", false, ["m"]), provider("q", true, ["n"])],
      pinnedModel: "p/m",
    });
    const labels = [noKey.action?.label, noModel.action?.label, dead.action?.label];
    expect(new Set(labels).size).toBe(3);
    expect(noKey.action?.page).toBe("models");
    expect(noModel.action?.page).toBe("models");
    expect(dead.action?.page).toBe("models");
  });

  it("只有 no_key / no_model / pinned_dead 算阻塞；no_pinned 不拦路", () => {
    expect(diagnoseRoute({ providers: [provider("p", false, ["m"])] }).blocking).toBe(true);
    expect(diagnoseRoute({ providers: [provider("p", true, [])] }).blocking).toBe(true);
    expect(
      diagnoseRoute({ providers: [provider("p", false, ["m"]), provider("q", true, ["n"])], pinnedModel: "p/m" }).blocking,
    ).toBe(true);
    expect(diagnoseRoute({ providers: [provider("p", true, ["m"])] }).blocking).toBe(false);
  });
});
