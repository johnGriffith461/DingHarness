import { app } from "electron";
import { normalizePinnedModel } from "../../shared/settings";
import { normalizeKeymap, type Keymap } from "../../shared/keymap";
import { normalizePersona, type PersonaPref } from "../../shared/persona";
import { normalizeRules, type PermissionRule } from "../../engine/core/permissionRules";
import path from "node:path";

import { createJsonStore } from "./jsonStore";

/**
 * 本机版应用设置（§183）。
 *
 * ## 为什么单开一个文件，而不是继续用 localStorage
 *
 * §156 的教训：**localStorage 是懒刷的，硬杀进程就没了**。
 * 设置这种东西关掉窗口再打开就复位，用户会觉得"我明明设过"。
 * 走主进程的原子写（先写 `.tmp` 再 rename），重启必在。
 *
 * ## 形状
 *
 * ```json
 * { "pinnedModel": "provider/model" }
 * ```
 *
 * `pinnedModel` 是**空串**就是"记忆上次"（默认）。
 *
 * ── C1（2026-10-13）：落盘收进 `./jsonStore` ──
 *
 * 这里原来已经是异步原子写了（12 个 store 里少数做对的那个），但**缺两样**：
 * 写失败不重试、没有信封版本。现在与其余 store 走同一条路，强度就一致了 ——
 * 这正是 C1 要的那件事：**同一条保证不该按模块换强度**。
 *
 * ⚠️ 磁盘上现存的 `settings.json` 是**裸对象**（没有信封）—— 会被读成"版本 0"并原样迁上来。
 */

/** IPC 通道名（preload 与主进程共用）。 */
export const APP_SETTINGS_CHANNEL = {
  read: "appSettings:read",
  write: "appSettings:write",
} as const;

/** 设置文件路径。 */
export function appSettingsPath(): string {
  return path.join(app.getPath("userData"), "settings.json");
}

/**
 * 本机版设置的形状。
 *
 * ⚠️ `navCollapsed`（左栏收起态，2026-10-16 审计 P187/P191）：**它必须在这里也认下来**。
 * 渲染层把收起态写进设置之后，主进程这一层若不多收一个字段，`normalizeAppSettings` 的收窄
 * 会在**没写进去或读回来**时把它丢掉 —— 表现是"界面以为记住了、重启仍然忘"，
 * 而且假桥（单测）不经过主进程，测试**查不出来**。所以收窄与类型两处一起加。
 */
export type AppSettings = {
  pinnedModel: string;
  navCollapsed?: boolean;
  /**
   * **权限规则**（U03 桌面那一半，2026-10-18）。
   *
   * 用户在审批卡片上点「总是允许」时生成一条；`agentTools()` 每轮从这里读，
   * 于是**重启之后仍然生效**（与 CLI 的 `config.rules` 同一套语义、同一份实现）。
   */
  rules?: PermissionRule[];
  /**
   * **键位表**（L06）：`palette` / `newChat` / `scheduled` → 组合字符串。
   *
   * 收窄在 `shared/keymap.ts`（渲染层用同一份判定）—— 这里只负责别在读写时丢掉它。
   */
  keymap?: Keymap;
  /** **助手人格偏好**（L06）：只影响提示词，不改界面排版。 */
  persona?: PersonaPref;
};

/**
 * 磁盘上这份设置**允许**出现的键（与 `AppSettings` 一一对应）。
 *
 * 给诊断包用（`./diagnostics.ts`）：它把 settings.json 的**原文**按这张表比对 ——
 * 手写进去的坏键会被 `normalizeAppSettings` 静默丢掉，而"我明明设了啊"就是从这里来的
 * （与 CLI 那边 `CONFIG_KEYS` 同一个理由，审计 P202）。
 */
export const APP_SETTINGS_KEYS = ["pinnedModel", "navCollapsed", "rules", "keymap", "persona"] as const;

/**
 * 把落盘的（不可信）值收窄。
 *
 * @param raw 落盘的值
 * @returns 干净的设置
 */
export function normalizeAppSettings(raw: unknown): AppSettings {
  const s = (raw ?? {}) as Record<string, unknown>;
  /* 收窄那半放在 `shared/settings.ts`（那里能单测，这里只负责读写文件） */
  const out: AppSettings = {
    pinnedModel: normalizePinnedModel(s.pinnedModel),
    /* 只认真正的 `true`（落盘的不可信：字符串 "false" 之类一律当"没收起"） */
    navCollapsed: s.navCollapsed === true,
  };
  /*
   * 规则走**引擎那一份** `normalizeRules`（不是在这里另写一遍）：
   * 它是"哪些规则算数"的唯一口径，CLI 与桌面必须同一份 ——
   * 否则同一条规则在命令行生效、在桌面被丢掉（或反过来）。
   */
  const rules = normalizeRules(s.rules);
  if (rules.length) out.rules = rules;
  /*
   * 键位（L06）：**总是**写进去（不是"有才写"）——
   * 渲染层拿到 `undefined` 会回默认，看起来一样，但诊断包里就看不到
   * "用户其实改过键位"。另两项同理：人格是空对象时省掉（它没有默认值可言）。
   */
  out.keymap = normalizeKeymap(s.keymap);
  const persona = normalizePersona(s.persona);
  if (Object.keys(persona).length) out.persona = persona;
  return out;
}

/**
 * 当前生效的权限规则（**同步**读缓存）。
 *
 * 为什么要有缓存：`agentTools()` 是同步装配（每轮工具集构造时调），
 * 而设置是异步读盘。所以在启动时灌一次、每次写盘时更新 —— 与
 * `src/workbench/appSettings.ts` 的"内存缓存"同一个取舍。
 */
let rulesCache: PermissionRule[] = [];

/** 更新缓存（写盘成功之后调一次）。 */
export function setPermissionRulesCache(rules: readonly PermissionRule[]): void {
  rulesCache = [...rules];
}

/** 读当前规则（给 `agentTools()` 用；没有就是空表 → 回落档位判定）。 */
export function currentPermissionRules(): readonly PermissionRule[] {
  return rulesCache;
}

/** 落盘器（C1：原子写 + 重试 + 信封版本，全部在 `./jsonStore` 里一份）。 */
const store = createJsonStore<AppSettings>({
  file: appSettingsPath,
  initial: () => normalizeAppSettings(null),
  normalize: (value) => normalizeAppSettings(value),
});

/**
 * 读设置。
 *
 * @returns 设置；文件不存在或坏了都给默认（**不让坏文件把应用卡住**）
 */
export async function loadAppSettings(): Promise<AppSettings> {
  const got = await store.read();
  // 读不动（磁盘上是更新的版本）只报一声：这里给的是默认值兜底，界面照常起得来
  if (got.foreign) console.error("[settings] 磁盘上的设置读不动（保留原样）：", got.note);
  /* 顺手把规则灌进缓存（`agentTools()` 同步读它） */
  setPermissionRulesCache(got.data.rules ?? []);
  return got.data;
}

/**
 * 写设置（原子写由 `./jsonStore` 负责）。
 *
 * ⚠️ 磁盘上是**更新的版本**时**拒绝覆盖**（`foreign`）：那是降级运行，
 * 硬写回去等于把用户的设置降级销毁 —— 同 §178.6 / §179.6 / §181.6 的取舍。
 *
 * ⚠️ **审计 P223**：写盘真失败时**抛错**，不再"打个日志、照样返回成功值"。
 * 原来 `if (!res.ok) console.error(...)` 之后仍 `return clean` —— `ipcMain.handle`
 * 正常 resolve，渲染层永远收不到失败信号，界面显示已保存、重启回到旧值。
 * 同仓 `codingStore`/`libraryStore`/`scheduleStore`/`taskStore` 都如实回 `res.ok`，
 * 只有 settings/history 这两条不一致（与文件头「同一条保证不该按模块换强度」相反）。
 *
 * @param next 要写的值（不可信，先收窄）
 * @returns 收窄之后真正写进去的值
 * @throws 落盘失败（重试过仍失败）时抛，让那次 IPC 明确 reject
 */
export async function saveAppSettings(next: unknown): Promise<AppSettings> {
  const clean = normalizeAppSettings(next);

  const current = await store.read();
  if (current.foreign) {
    console.error("[settings] 磁盘上的设置版本比本程序新，已拒绝覆盖：", current.note);
    return clean;
  }

  const res = await store.write(clean);
  if (!res.ok) {
    // 原来这里 catch 了什么都不说，表现是"设了、重启又复位"
    console.error("[settings] 落盘失败（重试过）：", res.error);
    throw new Error(`设置落盘失败：${res.error}`);
  }
  /* 写成功才更新缓存（失败时内存与盘上要保持一致 —— 都还是旧值） */
  setPermissionRulesCache(clean.rules ?? []);
  return clean;
}
