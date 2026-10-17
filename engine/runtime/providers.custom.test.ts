import { afterEach, describe, expect, it } from "vitest";

import { allProviders, customProviders, getProvider, protocolOf, setCustomProviders } from "./providers";

/**
 * 自定义 provider（V6-2j）。
 *
 * 三条硬规矩：
 *   ① **不能覆盖内置**（否则"我配的端点"会悄悄换掉内置定义，排错时看不见）；
 *   ② 字段不合法就**拒绝并说明**（不是静默丢）；
 *   ③ 自定义与内置走同一套解析（`getProvider` / `protocolOf` / `allProviders`）。
 */

afterEach(() => {
  setCustomProviders([]);
});

const good = {
  id: "my-gw",
  label: "公司网关",
  baseURL: "https://gw.example/v1",
  protocol: "openai-compatible" as const,
  keyRef: "MY_GW_KEY",
  models: ["m1", "m2"],
};

describe("自定义 provider", () => {
  it("注册后出现在 allProviders / getProvider / protocolOf 里", () => {
    expect(setCustomProviders([good]).rejected).toEqual([]);
    expect(customProviders().map((p) => p.id)).toEqual(["my-gw"]);
    expect(allProviders().some((p) => p.id === "my-gw")).toBe(true);
    expect(getProvider("my-gw")?.models).toEqual(["m1", "m2"]);
    expect(protocolOf("my-gw")).toBe("openai-compatible");
  });

  it("⭐ 不能与内置同名（内置定义不能被覆盖）", () => {
    const { rejected } = setCustomProviders([{ ...good, id: "deepseek" }]);
    expect(rejected[0]?.why).toContain("内置");
    expect(getProvider("deepseek")?.label).not.toBe(good.label);
  });

  it("坏字段逐条拒绝并说明原因（不静默丢）", () => {
    const { rejected } = setCustomProviders([
      { ...good, id: "BAD ID" },
      { ...good, id: "no-url", baseURL: "ftp://x" },
      { ...good, id: "no-key", keyRef: " " },
      { ...good, id: "no-models", models: [] },
      { ...good, id: "bad-proto", protocol: "weird" as never },
    ]);
    expect(rejected).toHaveLength(5);
    expect(rejected.map((r) => r.why).join("\n")).toMatch(/id|baseURL|keyRef|模型|协议/);
    expect(customProviders()).toEqual([]);
  });

  it("再次设置会整体替换（不是累加）", () => {
    setCustomProviders([good]);
    setCustomProviders([{ ...good, id: "second" }]);
    expect(customProviders().map((p) => p.id)).toEqual(["second"]);
  });
});
