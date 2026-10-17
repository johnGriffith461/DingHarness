import { ruleFromApproval } from "@engine/core/permissionRules";
import { useAppSettings } from "./appSettings";

/**
 * 「总是允许」的落地（U03，2026-10-18）。
 *
 * 单独一个文件的两个理由：
 * 1. `store.ts` 不许自己读写 `appSettings`（`workbenchWiring.test.ts` 的接线守卫）；
 * 2. `taskRuntime.ts` 与 `store.ts` 都盯着 900 行结构上限 —— 这段逻辑放哪都是多余的行。
 *
 * @param name 工具名
 * @param input 那次调用的参数（用来算"资源"：命令原文 / 文件所在目录）
 * @returns 是否真的写进去了（失败时设置 store 已经留了一句 note）
 */
export async function rememberAlwaysAllow(name: string, input: unknown): Promise<boolean> {
  const rule = ruleFromApproval({ action: name, ...(input === undefined ? {} : { input }) });
  return useAppSettings.getState().addRule({
    action: rule.action,
    ...(rule.resource === undefined ? {} : { resource: rule.resource }),
    effect: rule.effect,
    ...(rule.expiresAt === undefined ? {} : { expiresAt: rule.expiresAt }),
    ...(rule.note === undefined ? {} : { note: rule.note }),
  });
}
