import { describe, expect, it } from "vitest";
import {
  ARTIFACT_OP_STATUS,
  ARTIFACT_RESOURCE_TYPE,
  ARTIFACT_STATUS,
  artifactStatusOf,
  kindOfResourceType,
  resourceTypeOf,
} from "@shared/artifactProto";
import { ARTIFACT_FORMATS, type ArtifactKind } from "./artifact";

/**
 * 产物类型与状态的协议层对齐。
 *
 * **这些数字是从上位协议里读出来的，不是编的** —— 所以测试里把它们**写死一遍**。
 * 写死是有意的：哪天有人"顺手改个数"，这里会红，
 * 而不是让本地与协议的对应关系悄悄漂掉。
 */

describe("ArtifactResourceType —— 编号照协议写死", () => {
  it("逐个核对（协议里 0–17 共 18 档）", () => {
    expect(ARTIFACT_RESOURCE_TYPE.Undefined).toBe(0);
    expect(ARTIFACT_RESOURCE_TYPE.WriteDoc).toBe(1);
    expect(ARTIFACT_RESOURCE_TYPE.Pages).toBe(2);
    expect(ARTIFACT_RESOURCE_TYPE.CanvasPage).toBe(3);
    expect(ARTIFACT_RESOURCE_TYPE.StepWritingPage).toBe(4);
    expect(ARTIFACT_RESOURCE_TYPE.Code).toBe(5);
    expect(ARTIFACT_RESOURCE_TYPE.StepWritingOtterPage).toBe(6);
    expect(ARTIFACT_RESOURCE_TYPE.CodeBlock).toBe(7);
    expect(ARTIFACT_RESOURCE_TYPE.CodeDevelopMode).toBe(8);
    expect(ARTIFACT_RESOURCE_TYPE.Slides).toBe(9);
    expect(ARTIFACT_RESOURCE_TYPE.Docx).toBe(10);
    expect(ARTIFACT_RESOURCE_TYPE.StepDocx).toBe(11);
    expect(ARTIFACT_RESOURCE_TYPE.Excel).toBe(12);
    expect(ARTIFACT_RESOURCE_TYPE.Miaoda).toBe(13);
    expect(ARTIFACT_RESOURCE_TYPE.Wiki).toBe(14);
    expect(ARTIFACT_RESOURCE_TYPE.Base).toBe(15);
    expect(ARTIFACT_RESOURCE_TYPE.CanvasWorkspace).toBe(16);
    expect(ARTIFACT_RESOURCE_TYPE.Markdown).toBe(17);
  });

  it("编号没有重复、也没有空洞（0..17 正好铺满）", () => {
    const values = Object.values(ARTIFACT_RESOURCE_TYPE).sort((a, b) => a - b);
    expect(values).toEqual(Array.from({ length: 18 }, (_, i) => i));
  });
});

describe("本地产物类型 → 协议编号", () => {
  it("每个本地类型都有映射（不能有落回 Undefined 的）", () => {
    const kinds = Object.keys(ARTIFACT_FORMATS) as ArtifactKind[];
    expect(kinds.length).toBeGreaterThan(0);
    for (const kind of kinds) {
      expect(resourceTypeOf(kind), `${kind} 缺映射`).toBeGreaterThan(0);
    }
  });

  it("几个能一一对应的档位要精确对上", () => {
    expect(resourceTypeOf("docx")).toBe(10);
    expect(resourceTypeOf("xlsx")).toBe(12);
    expect(resourceTypeOf("pptx")).toBe(9);
    expect(resourceTypeOf("markdown")).toBe(17);
    expect(resourceTypeOf("code")).toBe(7);
  });

  it("反查能回来（一一对应的那几个）", () => {
    expect(kindOfResourceType(10)).toBe("docx");
    expect(kindOfResourceType(12)).toBe("xlsx");
    expect(kindOfResourceType(17)).toBe("markdown");
  });

  it("**对不上就明说 null**，不瞎猜一个类型", () => {
    // 13/14/15 是服务端生成的其它形态，本机版不做
    expect(kindOfResourceType(13)).toBeNull();
    expect(kindOfResourceType(14)).toBeNull();
    expect(kindOfResourceType(15)).toBeNull();
  });
});

describe("两套状态别混", () => {
  it("产物级状态编号", () => {
    expect(ARTIFACT_STATUS.Init).toBe(0);
    expect(ARTIFACT_STATUS.Generating).toBe(1);
    expect(ARTIFACT_STATUS.Generated).toBe(2);
    expect(ARTIFACT_STATUS.Deleted).toBe(3);
    expect(ARTIFACT_STATUS.Terminal).toBe(4);
    expect(ARTIFACT_STATUS.UnSupport).toBe(5);
  });

  it("操作级状态**从 1 起**（Start=1，不是 0）", () => {
    expect(ARTIFACT_OP_STATUS.Start).toBe(1);
    expect(ARTIFACT_OP_STATUS.Finish).toBe(2);
    expect(ARTIFACT_OP_STATUS.Updated).toBe(3);
    expect(ARTIFACT_OP_STATUS.Rollbacked).toBe(4);
  });

  it("两套状态是不同层的东西：一次产物生成里可以有多次写操作", () => {
    // 产物级只有"生成中/已生成"两个中间点，操作级有"开始/更新/完成"三段
    const one = [
      ARTIFACT_OP_STATUS.Start,
      ARTIFACT_OP_STATUS.Updated,
      ARTIFACT_OP_STATUS.Updated,
      ARTIFACT_OP_STATUS.Finish,
    ];
    expect(one.filter((s) => s === ARTIFACT_OP_STATUS.Updated).length).toBe(2);
    // 而产物级在这整段里只经历了 Generating → Generated
    expect(new Set([ARTIFACT_STATUS.Generating, ARTIFACT_STATUS.Generated]).size).toBe(2);
  });
});

describe("本地状态 → 协议产物级状态", () => {
  it("生成中 / 已生成 / 已删除 对上", () => {
    expect(artifactStatusOf("generating")).toBe(1);
    expect(artifactStatusOf("ready")).toBe(2);
    expect(artifactStatusOf("removed")).toBe(3);
  });

  it("没标状态按「已生成」算 —— 协议里 Init 是「还没开始」，不是「没标」", () => {
    expect(artifactStatusOf(undefined)).toBe(2);
  });
});
