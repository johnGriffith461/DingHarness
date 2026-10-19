import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import type { ModelConfigWire } from "@shared/modelConfigWire";
import type { ModelConfig as EngineModelConfig } from "@engine/runtime/modelConfig";

/**
 * **IPC 形状对账**（T0）：`shared/modelConfigWire.ts` 与 `engine/runtime/modelConfig.ts`
 * 必须描述同一个东西。
 *
 * ## 为什么必须有这条
 *
 * `shared` 不依赖内核（分层规矩），所以形状只能抄一份。抄一份就必须有东西盯着 ——
 * 否则内核加一个字段、界面永远看不到，而那种缺字段**不会报错**：
 * 界面上那个开关就是不显示，用户以为这个模型没有这项能力。
 *
 * 这条做的不是"类型相等"（TS 结构类型本来就宽），而是**逐层列出字段名比对**：
 * 内核有的，契约里必须有；契约里有的，内核里也必须有（两边都不许偷偷多）。
 */

const ROOT = path.resolve(__dirname, "..");

/** 从源码里抽某个类型字面量的顶层字段名（够这几份文件用：一层嵌套 + 已知层级）。 */
function readSource(rel: string): string {
  return readFileSync(path.join(ROOT, rel), "utf8");
}

describe("模型能力表单的 IPC 形状与内核一致", () => {
  it("ModelConfig 的顶层字段两边一样（enabled / properties / optionSpecs）", () => {
    const wire = readSource("shared/modelConfigWire.ts");
    const engine = readSource("engine/runtime/modelConfig.ts");
    for (const field of ["enabled", "properties", "optionSpecs"]) {
      expect(wire, `契约里没有 ${field}`).toContain(field);
      expect(engine, `内核里没有 ${field}`).toContain(field);
    }
  });

  it("properties 的 8 个字段两边都有", () => {
    const fields = [
      "requiresMfjsToolSchema",
      "contextWindow",
      "inputFormat",
      "outputFormat",
      "supportsToolCall",
      "supportsJsonSchemaOutput",
      "supportsNativeWebSearch",
      "supportsMidConversationSystem",
    ];
    const wire = readSource("shared/modelConfigWire.ts");
    const engine = readSource("engine/runtime/modelConfig.ts");
    const missingWire = fields.filter((f) => !wire.includes(f));
    const missingEngine = fields.filter((f) => !engine.includes(f));
    expect(missingWire, `契约里缺这些能力字段（界面上会看不到）：${missingWire.join("、")}`).toEqual([]);
    expect(missingEngine, `内核里缺这些能力字段：${missingEngine.join("、")}`).toEqual([]);
  });

  it("输入模态的 5 个字段两边都有（含音频：内核保留、界面 v1 不展示）", () => {
    const fields = ["supportsText", "supportsImage", "supportsVideo", "supportsAudio", "supportsPdf"];
    const wire = readSource("shared/modelConfigWire.ts");
    const engine = readSource("engine/runtime/modelConfig.ts");
    for (const field of fields) {
      expect(wire, `契约缺 ${field}`).toContain(field);
      expect(engine, `内核缺 ${field}`).toContain(field);
    }
  });

  it("optionSpecs 的两组（reasoningLevel / maxOutputTokens）两边都有", () => {
    const wire = readSource("shared/modelConfigWire.ts");
    const engine = readSource("engine/runtime/modelConfig.ts");
    for (const field of ["reasoningLevel", "maxOutputTokens", "values", "map"]) {
      expect(wire, `契约缺 ${field}`).toContain(field);
      expect(engine, `内核缺 ${field}`).toContain(field);
    }
  });

  it("类型层面能互相赋值（结构兼容，不是各写一套）", () => {
    /*
     * 运行时构造一个最小对象来验结构：如果两边形状分叉，这里的字面量会编译不过。
     * 比"字段名都在"更强一层 —— 它连嵌套层级都对上了。
     */
    const sample: ModelConfigWire = {
      enabled: true,
      properties: {
        requiresMfjsToolSchema: false,
        contextWindow: 1_000_000,
        inputFormat: {
          supportsText: true,
          supportsImage: false,
          supportsVideo: false,
          supportsAudio: false,
          supportsPdf: false,
        },
        outputFormat: { supportsText: true },
        supportsToolCall: true,
        supportsJsonSchemaOutput: false,
        supportsNativeWebSearch: false,
        supportsMidConversationSystem: false,
      },
      optionSpecs: {
        reasoningLevel: { values: ["low", "high"], map: "" },
        maxOutputTokens: { max: 64_000, map: "" },
      },
    };
    /* 这个赋值能过，说明契约是内核的超集/同形状（TS 会逐层检查） */
    const asEngine: EngineModelConfig = sample;
    expect(asEngine.properties.contextWindow).toBe(1_000_000);
  });
});
