import { describe, expect, it, vi } from "vitest";

/**
 * 路由解析（2026-10-16，审计 **P254**）。
 *
 * ## 钉住的是哪件事
 *
 * `resolveChatRoute` 在"用户没存过通道"时会列一遍 provider，挑第一个能用的。
 * 原来只判 `p.available` —— 于是**"可用但没有模型"**（自定义中转、模型清单没配、
 * 或拉取失败）会被选中，返回 `{provider, model:""}`。
 *
 * 危害不在这一行，而在**下一行**：调用方一律只判 `if (!provider)`
 * （`agentStore` / `docStore` ×2 / `taskRuntime`），守卫被绕过 ——
 * 请求带着空 model 发出去，用户看到上游 400/502，手里的线索指向错误的方向。
 * 本文件第 ③ 条承诺的是"都拿不到就返回空，让调用方明确报错"。
 *
 * ## 变异实证
 *
 * 把 `filter` 里的 `&& (p.models?.length ?? 0) > 0` 去掉（即旧行为）→ 第一个用例红
 * （拿到 `{provider:"p1", model:""}`）。
 */

const h = vi.hoisted(() => ({ providers: [] as unknown[], pinned: "" }));

vi.mock("./aiClient", () => ({ listProviders: async () => h.providers }));
/** 钉住的默认模型由各用例设置（`diagnoseRouteNow` 也读它）。 */
vi.mock("@/workbench/appSettings", () => ({ pinnedModelNow: () => h.pinned }));

const { diagnoseRouteNow, resolveChatRoute } = await import("./route");

describe("没有可用通道时不许返回「空 model」（P254）", () => {
  it("⭐ 可用但没有模型的通道要跳过，挑下一个真有模型的", async () => {
    h.providers = [
      { id: "p1", label: "自定义中转", models: [], available: true, keyRef: "" },
      { id: "p2", label: "另一家", models: ["m2"], available: true, keyRef: "" },
    ];
    const route = await resolveChatRoute();
    expect(route.provider).toBe("p2");
    expect(route.model, "model 不许是空串 —— 那就是「静默发一个空请求」").toBe("m2");
  });

  it("一个带模型的都没有 → 返回空 provider（让调用方的守卫真的生效）", async () => {
    h.providers = [
      { id: "p1", label: "只有密钥没模型", models: [], available: true, keyRef: "" },
      { id: "p2", label: "不可用", models: ["m"], available: false, keyRef: "" },
    ];
    const route = await resolveChatRoute();
    expect(route.provider).toBe("");
    expect(route.model).toBe("");
  });

  it("跳过没模型的之后仍然优先「已验证」那条", async () => {
    h.providers = [
      { id: "p1", label: "没模型", models: [], available: true, keyRef: "" },
      { id: "p2", label: "有密钥", models: ["m2"], available: true, keyRef: "" },
      { id: "p3", label: "已验证", models: ["m3"], available: true, verified: true, keyRef: "" },
    ];
    const route = await resolveChatRoute();
    expect(route.provider).toBe("p3");
    expect(route.model).toBe("m3");
  });
});

/**
 * F-03：**无通道时给诊断与可点的下一步**（2026-10-20）。
 *
 * 旧行为只有一句"还没有可用的 AI 通道（先确认至少一个 provider 配好了密钥）"——
 * 既没有下一步，又把"一个 key 都没有"与"有 key 没模型"混成同一句话。
 */
describe("diagnoseRouteNow：三种走不通的状态各说各的", () => {
  it("⭐ 一个 key 都没有 → 去填 key", async () => {
    h.pinned = "";
    h.providers = [{ id: "p1", label: "某家", models: ["m"], available: false, keyRef: "P_KEY" }];
    const d = await diagnoseRouteNow();
    expect(d.kind).toBe("no_key");
    expect(d.message).toContain("密钥");
    expect(d.action?.label).toBe("去填 key");
    expect(d.blocking).toBe(true);
  });

  it("⭐ 有 key、有模型、没钉住 → 提示「还没选模型」（不拦路）", async () => {
    h.pinned = "";
    h.providers = [{ id: "p1", label: "某家", models: ["m"], available: true, keyRef: "P_KEY" }];
    const d = await diagnoseRouteNow();
    expect(d.kind).toBe("no_pinned");
    expect(d.message).toContain("还没选模型");
    expect(d.action?.label).toBe("去选模型");
    expect(d.blocking).toBe(false);
  });

  it("⭐ 钉住的 provider 掉线 → 换一个模型", async () => {
    h.pinned = "p1/m";
    h.providers = [
      { id: "p1", label: "掉线的那家", models: ["m"], available: false, keyRef: "P_KEY" },
      { id: "p2", label: "还好的那家", models: ["m2"], available: true, keyRef: "P2_KEY" },
    ];
    const d = await diagnoseRouteNow();
    expect(d.kind).toBe("pinned_dead");
    expect(d.message).toContain("掉线的那家");
    expect(d.action?.label).toBe("换一个模型");
  });

  it("有 key 但没有任何模型 → 去添加模型", async () => {
    h.pinned = "";
    h.providers = [{ id: "p1", label: "只有 key", models: [], available: true, keyRef: "P_KEY" }];
    const d = await diagnoseRouteNow();
    expect(d.kind).toBe("no_model");
    expect(d.action?.label).toBe("去添加模型");
  });

  it("有 key、钉住且可用 → ok（没有动作）", async () => {
    h.pinned = "p1/m";
    h.providers = [{ id: "p1", label: "某家", models: ["m"], available: true, keyRef: "P_KEY" }];
    const d = await diagnoseRouteNow();
    expect(d.kind).toBe("ok");
    expect(d.action).toBeUndefined();
  });
});
