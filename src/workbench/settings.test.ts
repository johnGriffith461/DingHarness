import { describe, expect, it } from "vitest";
import {
  normalizePinnedModel,
  packPinned,
  pickRoute,
  pinnedLabel,
  pinnedStatus,
  fallbackNote,
  routeOptions, SETTINGS_LABELS, aboutTitle, memoryStateLabel, settingsSections } from "@shared/settings";

/**
 * 设置的分类与文案（§182，逐字取自证据 `settings_*`）。
 */
describe("设置文案（逐字）", () => {
  it("分类标题与记忆那两句", () => {
    expect(SETTINGS_LABELS.navigation).toBe("设置分类");
    expect(SETTINGS_LABELS.memory).toBe("记忆");
    expect(SETTINGS_LABELS.memoryOn).toBe("已开启");
    expect(SETTINGS_LABELS.memoryOff).toBe("已关闭");
  });

  it("开启新话题与它建成之后那句话", () => {
    expect(SETTINGS_LABELS.newTopic).toBe("开启新话题");
    expect(SETTINGS_LABELS.newTopicDone).toBe("已开启新话题");
  });

  it("关于页那几项", () => {
    expect(SETTINGS_LABELS.website).toBe("项目主页");
    expect(SETTINGS_LABELS.userPolicy).toBe("用户协议");
  });

  it("记忆状态两句话分开（开关要能看出状态）", () => {
    expect(memoryStateLabel(true)).toBe("已开启");
    expect(memoryStateLabel(false)).toBe("已关闭");
    expect(memoryStateLabel(true)).not.toBe(memoryStateLabel(false));
  });

  it("关于标题按 `关于%s` 拼", () => {
    expect(aboutTitle("Ding Harness")).toBe("关于Ding Harness");
    expect(aboutTitle("  ")).toBe("关于");
  });

  it("分类里有那四页（顺序即界面顺序）", () => {
    expect(settingsSections().map((s) => s.id)).toEqual(["profile", "account", "general", "about"]);
    expect(settingsSections().map((s) => s.label)).toEqual(["个人资料", "账号", "通用", "关于"]);
  });
});


describe("新对话默认模型（§183）", () => {
  const last = { provider: "p1", model: "m-last" };

  it("新对话 + 钉了默认 → 用钉的", () => {
    const got = pickRoute({ pinned: "p2/m-pin", last, fresh: true, available: [] });
    expect(got).toMatchObject({ provider: "p2", model: "m-pin", source: "pinned", fellBack: false });
  });

  it("⭐ 老对话 → **跟着上次**（默认模型不许劫持正在进行的对话）", () => {
    const got = pickRoute({ pinned: "p2/m-pin", last, fresh: false, available: [] });
    expect(got).toMatchObject({ provider: "p1", model: "m-last", source: "last" });
  });

  it("没钉 → 跟着上次", () => {
    expect(pickRoute({ pinned: "", last, fresh: true, available: [] })).toMatchObject({
      provider: "p1",
      model: "m-last",
      source: "last",
    });
  });

  it("⭐ 钉的那个不可用了 → 退回上次，并**标出退过**（静默换通道最坏）", () => {
    const got = pickRoute({ pinned: "p2/m-pin", last, fresh: true, available: ["p3/m3"] });
    expect(got).toMatchObject({ provider: "p1", model: "m-last", source: "last", fellBack: true });
  });

  it("可用列表为空（没拿到）时**按「还在」处理** —— 不误判成失效", () => {
    expect(pickRoute({ pinned: "p2/m-pin", last, fresh: true, available: [] }).source).toBe("pinned");
  });

  it("什么都没有 → none（调用方据此报「没有可用通道」）", () => {
    expect(pickRoute({ pinned: "", last: { provider: "", model: "" }, fresh: true, available: [] })).toMatchObject({
      source: "none",
      provider: "",
    });
  });

  it("模型名里带斜杠也能还原（`p/a/b` → model 是 `a/b`）", () => {
    const got = pickRoute({ pinned: "p/a/b", last, fresh: true, available: [] });
    expect(got.model).toBe("a/b");
  });
});

describe("默认模型的落盘形状（§183）", () => {
  it("`provider/model` 才算数", () => {
    expect(normalizePinnedModel("p1/m1")).toBe("p1/m1");
  });

  it("⭐ 半个值当没设（不然会发出缺 model 的请求）", () => {
    expect(normalizePinnedModel("p1")).toBe("");
    expect(normalizePinnedModel("p1/")).toBe("");
    expect(normalizePinnedModel("/m1")).toBe("");
  });

  it("坏类型给空串", () => {
    expect(normalizePinnedModel(null)).toBe("");
    expect(normalizePinnedModel(42)).toBe("");
    expect(normalizePinnedModel({})).toBe("");
  });

  it("packPinned 与它对称", () => {
    expect(packPinned("p1", "m1")).toBe("p1/m1");
    expect(packPinned("p1", "")).toBe("");
    expect(normalizePinnedModel(packPinned("p1", "m1"))).toBe("p1/m1");
  });

  it("界面那一项：没钉显示「记忆上次」", () => {
    expect(pinnedLabel("")).toBe("记忆上次");
    expect(pinnedLabel("p1/m1")).toBe("p1/m1");
  });
});

describe("可选通道（§183）", () => {
  it("把 provider 的模型摊平，label 是 `provider · model`", () => {
    const got = routeOptions([
      { id: "p1", models: ["m1", "m2"] },
      { id: "p2", models: ["m3"] },
    ]);
    expect(got.map((o) => o.label)).toEqual(["p1 · m1", "p1 · m2", "p2 · m3"]);
  });

  it("不可用的 provider 不进列表（别让用户挑一个用不了的）", () => {
    expect(routeOptions([{ id: "p1", models: ["m1"], available: false }])).toEqual([]);
  });

  it("没有模型的 provider 不产生空项", () => {
    expect(routeOptions([{ id: "p1", models: [] }])).toEqual([]);
  });
});

describe("钉住的默认模型失效（§184）", () => {
  it("没钉 → unset（不参与判断）", () => {
    expect(pinnedStatus("", ["p1/m1"])).toBe("unset");
    expect(pinnedStatus("半个值", ["p1/m1"])).toBe("unset");
  });

  it("还在可用列表里 → ok", () => {
    expect(pinnedStatus("p1/m1", ["p1/m1", "p2/m2"])).toBe("ok");
  });

  it("⭐ 不在了 → dead（这才是那个兜底真正会触发的情形）", () => {
    expect(pinnedStatus("p1/m1", ["p2/m2"])).toBe("dead");
  });

  it("⭐ 可用列表为空（没拿到信息）→ 按 ok 处理（不误报失效）", () => {
    expect(pinnedStatus("p1/m1", [])).toBe("ok");
  });

  it("失效那句话把钉的值写出来（用户要知道是哪个没了）", () => {
    expect(fallbackNote("p1/m1")).toContain("p1/m1");
    expect(fallbackNote("p1/m1")).toContain("不可用");
    expect(fallbackNote("p1/m1")).toContain("上次");
  });

  it("钉的值是坏的时候也不崩（那句话里不留空）", () => {
    expect(fallbackNote("不是通道")).toContain("未设");
  });
});
