import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  MODEL_CONFIG_FILENAME,
  emptyModelConfigFile,
  findExactRule,
  modelConfigPath,
  readModelConfig,
  removeExactRule,
  upsertExactRule,
  validateRule,
  writeModelConfig,
} from "./modelConfigStore";
import type { ModelConfigRule } from "../runtime/modelConfig";

/**
 * `models.json` 的读写（T0）。
 *
 * 两件最容易出事的：**坏文件不能让应用起不来**（但要如实报出来）、
 * 以及**同一模型不能留下两条规则**（那会让"我改过了"变成"为什么没生效"）。
 */

const dirs: string[] = [];
function freshDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "dh-models-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const exact = (modelId: string, window: number, manual = true): Extract<ModelConfigRule, { type: "exact" }> => ({
  type: "exact",
  providerId: "tokenrhythm",
  modelId,
  config: { properties: { contextWindow: window } },
  manual,
});

describe("路径与空文件", () => {
  it("落在数据目录的 models.json", () => {
    expect(modelConfigPath("/data")).toBe(path.join("/data", MODEL_CONFIG_FILENAME));
  });

  it("文件不存在 = 没有用户规则（老用户零迁移）", () => {
    const got = readModelConfig(freshDir());
    expect(got.file).toEqual(emptyModelConfigFile());
    expect(got.errors).toEqual([]);
  });
});

describe("读写往返", () => {
  it("写完能读回来，规则一条不丢", () => {
    const dir = freshDir();
    const rules = [exact("m1", 1_000_000), exact("m2", 200_000)];
    writeModelConfig(dir, rules);
    const got = readModelConfig(dir);
    expect(got.errors).toEqual([]);
    expect(got.file.rules).toHaveLength(2);
    expect(got.file.version).toBe(1);
  });

  it("坏 JSON 不抛，但把原因报出来（不能静默吞）", () => {
    const dir = freshDir();
    writeFileSync(modelConfigPath(dir), "{not json", "utf8");
    const got = readModelConfig(dir);
    expect(got.file.rules).toEqual([]);
    expect(got.errors[0]).toContain("不是合法 JSON");
  });

  it("形状不对（缺 rules）也报出来", () => {
    const dir = freshDir();
    writeFileSync(modelConfigPath(dir), '{"version":1}', "utf8");
    expect(readModelConfig(dir).errors[0]).toContain("形状不对");
  });

  it("单条坏规则被跳过，好的仍然生效（一条坏规则不该毁掉全部）", () => {
    const dir = freshDir();
    writeFileSync(
      modelConfigPath(dir),
      JSON.stringify({ version: 1, rules: [exact("good", 100), { type: "unknown" }] }),
      "utf8",
    );
    const got = readModelConfig(dir);
    expect(got.file.rules).toHaveLength(1);
    expect(got.errors).toHaveLength(1);
    expect(got.errors[0]).toContain("第 2 条");
  });
});

describe("规则校验", () => {
  it("exact 缺 providerId / modelId 被拒", () => {
    expect(validateRule({ type: "exact", modelId: "m", config: {} })).toContain("providerId");
    expect(validateRule({ type: "exact", providerId: "p", config: {} })).toContain("modelId");
  });

  it("缺 config 一律被拒", () => {
    expect(validateRule({ type: "model", modelMatch: "m" })).toContain("config");
  });

  it("未知类型被拒", () => {
    expect(validateRule({ type: "nope", config: {} })).toContain("未知");
  });

  it("manual 不是 true 时按 false 处理（只有显式 true 才算手动）", () => {
    const rule = validateRule({ type: "exact", providerId: "p", modelId: "m", config: {}, manual: "yes" });
    expect(typeof rule === "string", "这条应当通过校验").toBe(false);
    expect((rule as { manual?: boolean }).manual).toBe(false);
  });
});

describe("同模型的唯一性", () => {
  it("upsert 后只剩一条（改了两次不该叠成两条）", () => {
    const rules = upsertExactRule([exact("m", 100)], exact("m", 200));
    expect(rules).toHaveLength(1);
    expect(findExactRule(rules, "tokenrhythm", "m")?.config.properties?.contextWindow).toBe(200);
  });

  it("upsert 不动别的模型", () => {
    const rules = upsertExactRule([exact("a", 100), exact("b", 200)], exact("a", 300));
    expect(rules).toHaveLength(2);
    expect(findExactRule(rules, "tokenrhythm", "b")?.config.properties?.contextWindow).toBe(200);
  });

  it("remove 只删指定模型", () => {
    const rules = removeExactRule([exact("a", 100), exact("b", 200)], "tokenrhythm", "a");
    expect(rules).toHaveLength(1);
    expect(findExactRule(rules, "tokenrhythm", "a")).toBeUndefined();
  });
});
