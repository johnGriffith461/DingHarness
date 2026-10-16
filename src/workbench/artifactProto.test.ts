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

  it("**八个档位逐个精确对上**（G53.w：原来 html / image / canvas 只断 >0）", () => {
    /*
     * ⚠️ 2026-10-16（审计 G53.w）：这条原来只精确钉了五个（docx/xlsx/pptx/markdown/code），
     * html / image / canvas 落在 `>0` 的笼统判定里 —— 把 html 顺手改成"图片"那一档
     * （都是正数）也照样绿。现在八个一起钉死；`KIND_TO_TYPE` 里加新档位时这里要跟着加。
     */
    const EXPECTED: Record<string, number> = {
      markdown: 17,
      docx: 10,
      pptx: 9,
      xlsx: 12,
      code: 7,
      /* 下面三个是"协议里没有一一对应档位"的：html→Pages(2)、image→CanvasWorkspace(16)、canvas→CanvasPage(3) */
      html: 2,
      image: 16,
      canvas: 3,
    };
    expect(Object.keys(ARTIFACT_FORMATS).sort(), "本地 kind 与这张表对不上（新档位要登记）").toEqual(
      Object.keys(EXPECTED).sort(),
    );
    for (const [kind, type] of Object.entries(EXPECTED)) {
      expect(resourceTypeOf(kind as ArtifactKind), `${kind} 映射到的协议编号不对`).toBe(type);
    }
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
    /*
     * ⚠️ 2026-10-16（审计 G53.w）：原来这段断言的是**测试自己拼的数组**
     * （`one.filter(...).length === 2`、`new Set([两个常量]).size === 2`）——
     * 被测模块一行没参与。现在断**产品**的两条真性质：
     *   ① 两套编号**不相交**（混用就会把"产物已生成"读成"某次写操作完成"）；
     *   ② 本地三态 → 协议状态是**多对一的确定性映射**（生成中/已生成/已删除各归各的）。
     */
    /*
     * ⚠️ 两套编号**在数值上就是重叠的**（操作级 1–4、产物级 0–5）—— 那是上游协议定的，
     * 不是缺陷；别把"不相交"当成产品性质来断（第一版这么写过，红的是断言不是产品）。
     * 要钉的是两张表**各自**的取值，以及本地三态到协议态的映射。
     */
    expect(ARTIFACT_OP_STATUS, "操作级状态表被改了").toEqual({ Start: 1, Finish: 2, Updated: 3, Rollbacked: 4 });
    expect(ARTIFACT_STATUS, "产物级状态表被改了").toEqual({
      Init: 0,
      Generating: 1,
      Generated: 2,
      Deleted: 3,
      Terminal: 4,
      UnSupport: 5,
    });

    const mapped = {
      generating: artifactStatusOf("generating"),
      ready: artifactStatusOf("ready"),
      removed: artifactStatusOf("removed"),
    };
    expect(mapped.generating).toBe(ARTIFACT_STATUS.Generating);
    expect(mapped.ready).toBe(ARTIFACT_STATUS.Generated);
    expect(mapped.removed).toBe(ARTIFACT_STATUS.Deleted);
    /* 三个本地态必须映到三个**不同**的协议态（映成一个就等于丢了状态） */
    expect(new Set(Object.values(mapped)).size).toBe(3);
    /* 缺省（没标状态）→ 按"已生成"算：协议里 Init 是"还没开始"，而本地拿到手的产物不是那种 */
    expect(artifactStatusOf(undefined)).toBe(ARTIFACT_STATUS.Generated);
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
