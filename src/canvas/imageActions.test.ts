import { describe, expect, it } from "vitest";
import { IMAGE_ACTIONS, actionSizeFor, imageAction, targetSizeFor } from "./imageActions";
/** 尺寸这两件事由 `shared/imageSize` 实现，这里只把它们**注入**进去（实现不重复）。 */
import { normalize, parseSize } from "@shared/imageSize";

describe("IMAGE_ACTIONS 定义", () => {
  it("四个动作齐全，id 唯一", () => {
    // §167：按证据补了「消除」（`aiCreation_canvas_imageAction_remove`）
    expect(IMAGE_ACTIONS.map((a) => a.id).sort()).toEqual(["cutout", "edit", "enhance", "expand", "remove"]);
    expect(new Set(IMAGE_ACTIONS.map((a) => a.id)).size).toBe(IMAGE_ACTIONS.length);
  });

  it("每个动作都有标签与提示词产出", () => {
    for (const a of IMAGE_ACTIONS) {
      expect(a.label.length).toBeGreaterThan(0);
      expect(a.hint.length).toBeGreaterThan(0);
      expect(a.prompt({}).length).toBeGreaterThan(10);
    }
  });

  it("只有自由编辑需要用户输入", () => {
    /*
     * ⭐ 标签是**逐字照证据**的（§167）：
     * `aiCreation_canvas_imageAction_*` = 抠图 / 编辑 / 变清晰 / 扩图 / 消除。
     * 之前写的是「增强」—— 意思对但不是原版那个词。
     */
    expect(imageAction("enhance")?.label).toBe("变清晰");
    expect(imageAction("cutout")?.label).toBe("抠图");
    expect(imageAction("expand")?.label).toBe("扩图");
    expect(imageAction("edit")?.label).toBe("编辑");
    expect(imageAction("remove")?.label).toBe("消除");

expect(imageAction("edit")?.needsInstruction).toBe(true);
    expect(imageAction("cutout")?.needsInstruction).toBe(false);
    expect(imageAction("expand")?.needsInstruction).toBe(false);
  });
});

describe("提示词内容", () => {
  it("改造类动作都要求保持主体不变（不写这句上游会顺手把主体换掉）", () => {
    for (const id of ["cutout", "enhance", "expand", "edit"] as const) {
      const p = imageAction(id)?.prompt({ instruction: "改成水彩" }) ?? "";
      expect(/主体|构图/.test(p)).toBe(true);
    }
  });

  it("自由编辑会把用户的指令拼进去", () => {
    const p = imageAction("edit")?.prompt({ instruction: "把天空换成星空" }) ?? "";
    expect(p).toContain("把天空换成星空");
  });

  it("自由编辑的空指令不会产出半截提示词", () => {
    const p = imageAction("edit")?.prompt({}) ?? "";
    expect(p.endsWith("：")).toBe(true); // 结尾是冒号，说明确实没拼上东西
    // 界面上这种动作会被禁用（needsInstruction + 空输入），所以不会真的发出去
  });
});

describe("targetSizeFor", () => {
  const src = { w: 1024, h: 1024 };

  it("抠图 / 增强 / 编辑沿用原尺寸（不给目标尺寸 = 主进程沿用输入图）", () => {
    for (const id of ["cutout", "enhance", "edit"] as const) {
      expect(targetSizeFor(imageAction(id)!, src, normalize)).toBeUndefined();
    }
  });

  it("扩图给出放大后的规整尺寸", () => {
    // 1024×1024 ×2 = 2048×2048
    expect(targetSizeFor(imageAction("expand")!, src, normalize)).toBe("2048x2048");
  });

  it("扩图的结果也过规整（16 倍数 / 边界内）", () => {
    const out = targetSizeFor(imageAction("expand")!, { w: 1280, h: 720 }, normalize);
    expect(out).toBe("2560x1440");
    const [w, h] = out!.split("x").map(Number);
    expect(w % 16).toBe(0);
    expect(h % 16).toBe(0);
    expect(Math.max(w, h)).toBeLessThanOrEqual(3840);
  });

  it("源尺寸未知时不猜（返回 undefined）", () => {
    expect(targetSizeFor(imageAction("expand")!, undefined, normalize)).toBeUndefined();
  });

  it("超大源图放大后会被夹回上限，不会产出越界尺寸", () => {
    const out = targetSizeFor(imageAction("expand")!, { w: 3840, h: 2160 }, normalize);
    const [w, h] = out!.split("x").map(Number);
    expect(Math.max(w, h)).toBeLessThanOrEqual(3840);
    expect(w * h).toBeLessThanOrEqual(8294400);
  });
});

describe("imageAction", () => {
  it("未知 id 返回 undefined（界面据此不显示按钮）", () => {
    expect(imageAction("nope" as never)).toBeUndefined();
  });
});

describe("消除（§167 按证据补的）", () => {
  it("要用户说清「消除什么」（与编辑同样是需要指令的那类）", () => {
    expect(imageAction("remove")?.needsInstruction).toBe(true);
  });

  it("⭐ 提示词要死死按住「别的内容一律不动」 —— 否则模型会把整张图重画一遍", () => {
    const p = imageAction("remove")!.prompt({ instruction: "路边的垃圾桶" });
    expect(p).toContain("路边的垃圾桶");
    expect(p).toContain("保持不变");
    expect(p).toContain("不要重画整张图");
  });

  it("尺寸沿用原图（消除不改变画布）", () => {
    const normalize = (w: number, h: number): [number, number] => [w, h];
    expect(targetSizeFor(imageAction("remove")!, { w: 1024, h: 1024 }, normalize)).toBeUndefined();
  });
});

describe("actionSizeFor（§167：把「源尺寸 → 目标尺寸」抽出来单独钉住）", () => {
  it("⭐ 扩图**必须真的算出更大的尺寸** —— 传 undefined 的话它永远不放大，而且看不出来", () => {
    expect(actionSizeFor("expand", "1024x1024", parseSize, normalize)).toBe("2048x2048");
  });

  it("沿用原尺寸的那几个给 undefined（让主进程用输入图的尺寸）", () => {
    for (const id of ["cutout", "enhance", "remove", "edit"] as const) {
      expect(actionSizeFor(id, "1024x1024", parseSize, normalize), id).toBeUndefined();
    }
  });

  it("源尺寸未知时也给 undefined（不瞎猜一个尺寸）", () => {
    expect(actionSizeFor("expand", undefined, parseSize, normalize)).toBeUndefined();
    expect(actionSizeFor("expand", "不是尺寸", parseSize, normalize)).toBeUndefined();
  });

  it("不认识的 id 给 undefined（不炸）", () => {
    expect(actionSizeFor("nope" as never, "1024x1024", parseSize, normalize)).toBeUndefined();
  });

  it("宽高比不是 1:1 时也按倍率放大", () => {
    const got = actionSizeFor("expand", "1280x720", parseSize, normalize);
    expect(got).not.toBe("1280x720");
    expect(got).toMatch(/^\d+x\d+$/);
  });
});
