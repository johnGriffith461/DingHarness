import { isBuiltinProviderId } from "@engine/runtime/providers";

/**
 * **删除 / 隐藏供应商的级联计划**（M-06）。
 *
 * 照 ZCode 的三件套：provider 记录 + 该 provider 的模型声明 + 模型设置里那一项。
 * 我们的落点还多两处：localStorage 的启用状态、以及凭据库里的 key。
 *
 * 内置 provider **不能删**（`config.json` 里没有它，删了下次启动又回来 ——
 * 那才是"删了又活"的鬼故事），只能隐藏：从模型选择器里消失，设置里能恢复。
 */

export type CascadePlan =
  | { action: "hide"; providerId: string }
  | {
      action: "delete";
      providerId: string;
      /** `models.json` 里属于它的声明（要逐条删）。 */
      declaredModels: string[];
      /** 其中启用着的数量（确认框里要说清）。 */
      enabledCount: number;
      /** localStorage 里有没有它的设置项（要清掉）。 */
      clearsSettings: boolean;
      /** 它的密钥引用名（要尽量从本机凭据库删掉）。 */
      keyRef?: string;
    };

export type CascadeContext = {
  declared: ReadonlyArray<{ providerId: string; modelId: string }>;
  settings?: Record<string, { enabled?: string[] }>;
  keyRef?: string;
};

/**
 * 算一次删除/隐藏要动哪些东西。
 *
 * @param providerId 目标 provider
 * @param ctx 当前声明、设置、密钥引用名
 */
export function cascadePlan(providerId: string, ctx: CascadeContext): CascadePlan {
  if (isBuiltinProviderId(providerId)) return { action: "hide", providerId };
  const declaredModels = ctx.declared.filter((m) => m.providerId === providerId).map((m) => m.modelId);
  const entry = ctx.settings?.[providerId];
  return {
    action: "delete",
    providerId,
    declaredModels: [...new Set(declaredModels)],
    enabledCount: entry?.enabled?.length ?? 0,
    clearsSettings: Boolean(entry),
    ...(ctx.keyRef ? { keyRef: ctx.keyRef } : {}),
  };
}
