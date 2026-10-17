import { describe, expect, it } from "vitest";

import { dependencyCycle, dependencyProblems, parseDependencies } from "./pluginDeps";

/**
 * **插件依赖**（L04）的回归：形状校验、四种不满足、环检测。
 */

describe("parseDependencies", () => {
  it("不写 dependencies → 空表（不是错误）", () => {
    expect(parseDependencies(undefined)).toEqual({ deps: {}, errors: [] });
  });

  it("正常依赖表原样保留", () => {
    const got = parseDependencies({ "word-count": "^1.0.0", other: ">=0.2" });
    expect(got.errors).toEqual([]);
    expect(got.deps).toEqual({ "word-count": "^1.0.0", other: ">=0.2" });
  });

  it("不是对象 → 报错（别把数组当依赖表）", () => {
    const got = parseDependencies(["word-count"]);
    expect(got.errors[0]).toContain("必须是对象");
  });

  it("插件名不合法 / 值不是字符串 → 各自报出来", () => {
    const got = parseDependencies({ Bad_Name: "1.0.0", ok: 1 });
    expect(got.errors).toHaveLength(2);
  });
});

describe("dependencyProblems", () => {
  const installed = [
    { name: "word-count", version: "1.2.0", enabled: true },
    { name: "old-one", version: "0.9.0", enabled: true },
    { name: "off-one", version: "1.0.0", enabled: false },
  ];

  it("依赖满足 → 空数组", () => {
    expect(dependencyProblems({ name: "x", dependencies: { "word-count": "^1.0.0" } }, installed)).toEqual([]);
  });

  it("没装 → 说缺哪个，并给出装法", () => {
    const problems = dependencyProblems({ name: "x", dependencies: { missing: "^1.0.0" } }, installed);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("缺依赖「missing」");
    expect(problems[0]).toContain("index:missing");
  });

  it("装了但关着 → 提示 enable（关着等于没装）", () => {
    const problems = dependencyProblems({ name: "x", dependencies: { "off-one": "^1.0.0" } }, installed);
    expect(problems[0]).toContain("ding plugins enable off-one");
  });

  it("版本不符 → 报需要什么、装的是什么", () => {
    const problems = dependencyProblems({ name: "x", dependencies: { "old-one": "^1.0.0" } }, installed);
    expect(problems[0]).toContain("需要 ^1.0.0");
    expect(problems[0]).toContain("装的是 0.9.0");
  });

  it("依赖自己 → 直接说永远装不上", () => {
    const problems = dependencyProblems({ name: "x", dependencies: { x: "*" } }, installed);
    expect(problems[0]).toContain("依赖里写了自己");
  });
});

describe("dependencyCycle", () => {
  it("无环 → 空", () => {
    const deps: Record<string, Record<string, string>> = { a: { b: "*" }, b: {} };
    expect(dependencyCycle("a", (name) => deps[name] ?? {})).toEqual([]);
  });

  it("a→b→a → 报出环上的名字", () => {
    const deps: Record<string, Record<string, string>> = { a: { b: "*" }, b: { a: "*" } };
    expect(dependencyCycle("a", (name) => deps[name] ?? {})).toEqual(["a", "b", "a"]);
  });

  it("自环 → 自己出现两次", () => {
    expect(dependencyCycle("a", () => ({ a: "*" }))).toEqual(["a", "a"]);
  });
});
