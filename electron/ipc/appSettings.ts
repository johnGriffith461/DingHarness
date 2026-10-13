import { app } from "electron";
import { normalizePinnedModel } from "../../shared/settings";
import fs from "node:fs/promises";
import path from "node:path";

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

/** 本机版设置的形状。 */
export type AppSettings = { pinnedModel: string };

/**
 * 读设置。
 *
 * @returns 设置；文件不存在或坏了都给默认（**不让坏文件把应用卡住**）
 */
export async function loadAppSettings(): Promise<AppSettings> {
  try {
    const raw = await fs.readFile(appSettingsPath(), "utf8");
    // ⚠️ 读回一律过一遍收窄（§178 的规矩）：磁盘上的东西不可信
    return normalizeAppSettings(JSON.parse(raw) as unknown);
  } catch {
    return { pinnedModel: "" };
  }
}

/**
 * 把落盘的（不可信）值收窄。
 *
 * @param raw 落盘的值
 * @returns 干净的设置
 */
export function normalizeAppSettings(raw: unknown): AppSettings {
  const s = (raw ?? {}) as Record<string, unknown>;
  /* 收窄那半放在 `shared/settings.ts`（那里能单测，这里只负责读写文件） */
  return { pinnedModel: normalizePinnedModel(s.pinnedModel) };
}

/**
 * 写设置（原子写）。
 *
 * @param next 要写的值（不可信，先收窄）
 * @returns 收窄之后真正写进去的值
 */
export async function saveAppSettings(next: unknown): Promise<AppSettings> {
  const clean = normalizeAppSettings(next);
  const target = appSettingsPath();
  const temp = `${target}.tmp`;
  try {
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(temp, JSON.stringify(clean, null, 2), "utf8");
    await fs.rename(temp, target);
  } catch {
    await fs.rm(temp, { force: true }).catch(() => undefined);
  }
  return clean;
}
