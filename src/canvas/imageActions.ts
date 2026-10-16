/**
 * 图片动作（阶段 9.3，对标原版 `aiCreation_canvas_imageAction_*`）。
 *
 * 原版在图片节点上有一组动作：抠图 / 编辑 / 增强 / 扩图 / 移除。它们本质是同一件事 ——
 * **拿现成的图 + 一段提示词，图生图改一版**。所以这里把"动作"定义成
 * 「标签 + 提示词 + 目标尺寸策略」，共用一条 `/images/edits` 通道。
 *
 * 尺寸策略为什么要分开说：改造画面（抠图/增强）应当**沿用原尺寸**，
 * 而"扩图"按定义就是要更大的画布 —— 把两者混成一个策略，扩图会扩不出去。
 */

export type ImageActionId = "cutout" | "enhance" | "expand" | "edit" | "remove";

/** 生成动作提示词时可用的上下文。 */
export type ImageActionContext = {
  /** 用户自由输入的指令（只有 `edit` 会用到）。 */
  instruction?: string;
  /** 输入图的实际宽高（用于给出保持比例的目标尺寸）。 */
  sourceSize?: { w: number; h: number };
};

export type ImageActionDef = {
  id: ImageActionId;
  label: string;
  /** 按钮上的 tooltip。 */
  hint: string;
  /** 是否需要用户输入指令（自由编辑）。 */
  needsInstruction: boolean;
  /**
   * 产出提示词。
   * @param ctx 动作上下文
   * @returns 提交给上游的提示词
   */
  prompt: (ctx: ImageActionContext) => string;
  /**
   * 目标尺寸策略：
   *   `keep` 沿用输入图尺寸；`scale` 按倍率放大（扩图用）。
   */
  sizeStrategy: (ctx: ImageActionContext) => { kind: "keep" } | { kind: "scale"; factor: number };
};

export const IMAGE_ACTIONS: ImageActionDef[] = [
  {
    id: "cutout",
    label: "抠图",
    hint: "把主体完整扣出来，背景换成干净的纯白",
    needsInstruction: false,
    prompt: () =>
      "把画面中的主体完整抠出来，主体边缘干净、不缺损、不改变主体本身；背景换成纯白，不要添加任何其它元素。",
    sizeStrategy: () => ({ kind: "keep" }),
  },
  {
    id: "enhance",
    /*
     * 标签逐字取自证据 `aiCreation_canvas_imageAction_enhance` = **变清晰**。
     * （原来写的是「增强」—— 意思对，但不是原版那个词，§167 改回来。）
     */
    label: "变清晰",
    hint: "提升清晰度与光影层次，构图与主体保持不变",
    needsInstruction: false,
    prompt: () =>
      "保持构图与主体完全不变，提升画面清晰度、细节锐度与光影层次，修正噪点与模糊，输出更高质量的一版。",
    sizeStrategy: () => ({ kind: "keep" }),
  },
  {
    id: "expand",
    label: "扩图",
    hint: "向外扩展画面（等比放大后自然延续背景）",
    needsInstruction: false,
    prompt: () =>
      "保留画面中心的主体与构图，向四周自然扩展场景，延伸背景的透视与光线，让画面更完整、更有空间感；不要裁掉原有内容。",
    // 扩图按定义要更大的画布
    sizeStrategy: () => ({ kind: "scale", factor: 2 }),
  },
  {
    id: "edit",
    label: "编辑",
    hint: "用一句话描述你想怎么改",
    needsInstruction: true,
    prompt: (ctx) => {
      const instruction = String(ctx.instruction ?? "").trim();
      // 把"保持主体"写进提示词：不加这句，上游经常顺手把主体也换了
      /*
       * ⚠️ 2026-10-16（审计 G53.p）：原来无条件拼 `：${instruction}` —— 指令为空时
       * 产出的是一句**以冒号结尾的半截话**（"……保持不变："），而那条测试还把这个
       * 缺陷形态钉成了期望值。现在空指令只留完整的基础句（界面本来也会禁用这个动作，
       * 但真跑到这里也不该给上游半截提示词）。
       */
      const base = "在原图基础上按以下要求修改，保持主体与整体构图不变";
      return instruction ? `${base}：${instruction}` : `${base}。`;
    },
    sizeStrategy: () => ({ kind: "keep" }),
  },
  {
    /*
     * 消除（§167，证据 `aiCreation_canvas_imageAction_remove` = **消除**）。
     *
     * 与"编辑"的区别只是**措辞与边界**：消除要明确"别的东西一律不动"，
     * 否则模型常顺手把整张图重画一遍 —— 那不是消除，是重新生成。
     * 要用户说清"消除什么"，所以同样 `needsInstruction`。
     */
    id: "remove",
    label: "消除",
    hint: "擦掉画面里的某个东西，其余保持不变",
    needsInstruction: true,
    prompt: (ctx) => {
      const instruction = String(ctx.instruction ?? "").trim();
      /* 同上：空指令不产出「（空的引号）」这种半成品（`remove` 与 `edit` 是同一族） */
      if (!instruction) return "把画面里的那个东西去掉，并用周围自然的背景补上那一块；画面里的其它内容、构图与光线一律保持不变，不要重画整张图。";
      return `只把画面中的「${instruction}」去掉，并用周围自然的背景补上那一块；画面里的其它内容、构图与光线一律保持不变，不要重画整张图。`;
    },
    sizeStrategy: () => ({ kind: "keep" }),
  },
];

/** 按 id 取动作定义。 */
export function imageAction(id: ImageActionId): ImageActionDef | undefined {
  return IMAGE_ACTIONS.find((a) => a.id === id);
}

/**
 * 算出动作要提交的目标尺寸。
 *
 * @param action 动作
 * @param source 输入图尺寸
 * @param normalizeSize 尺寸规整函数（来自 `shared/imageSize`，由调用方注入以免这里重复实现规格）
 * @returns 目标 `WxH`；源尺寸未知时返回 undefined（交给主进程沿用输入图尺寸）
 */
export function targetSizeFor(
  action: ImageActionDef,
  source: { w: number; h: number } | undefined,
  normalizeSize: (w: number, h: number) => [number, number],
): string | undefined {
  if (!source) return undefined;
  const strategy = action.sizeStrategy({ sourceSize: source });
  if (strategy.kind === "keep") return undefined;
  const [w, h] = normalizeSize(source.w * strategy.factor, source.h * strategy.factor);
  return `${w}x${h}`;
}

/**
 * 从"已知的尺寸字符串"算动作要提交的目标尺寸（§167 抽出来的）。
 *
 * ## 为什么必须抽出来单测
 *
 * 界面那层很容易写成 `targetSizeFor(action, undefined, …)` ——
 * **那样永远返回 undefined，扩图就永远不放大**，而且**看不出来**：
 * 图能生成、只是没变大。（我在写动作条时真犯了这个错。）
 *
 * 把"源尺寸字符串 → 目标尺寸"这一段拿出来，就能在**没有模型**的情况下钉住它。
 *
 * @param id 动作 id
 * @param sourceSize 输入图尺寸（例如 `1024x1024`；未知给 undefined）
 * @param parse 尺寸解析（`shared/imageSize` 的 `parseSize`）
 * @param normalizeSize 尺寸规整
 * @returns 目标 `WxH`；沿用原尺寸或源尺寸未知时返回 undefined
 */
export function actionSizeFor(
  id: ImageActionId,
  sourceSize: string | undefined,
  parse: (input: string) => { w: number; h: number } | null,
  normalizeSize: (w: number, h: number) => [number, number],
): string | undefined {
  const action = imageAction(id);
  if (!action) return undefined;
  const wh = sourceSize ? parse(sourceSize) : null;
  return targetSizeFor(action, wh ?? undefined, normalizeSize);
}
