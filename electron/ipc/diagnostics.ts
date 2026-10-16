import fs from "node:fs";
import path from "node:path";
import { app, ipcMain, shell } from "electron";

import { doctorReport, runDoctor, type Check } from "../../engine/runtime/doctor";
import { APP_SETTINGS_KEYS, appSettingsPath } from "./appSettings";

/**
 * 诊断包导出（2026-10-17，V5 开工前清尾：技能面板「反馈」那颗死控件的**真归宿**）。
 *
 * ## 它是什么
 *
 * 本机版没有"上报到某个服务端"那条路（也不该有 —— 本地主权）。反馈通道的本地形态
 * 就是**导出一个诊断包**：把"跑不起来时医生会看的那些"打包成一个 JSON 文件，
 * 用户自己把它贴给下一个能帮他的人（或留给未来的自己）。
 *
 * ## 复用 doctor，不另写一套自检
 *
 * 检查项**只有一份实现**（`engine/runtime/doctor.ts`）：这里给它喂桌面的配置视图
 * （settings.json 的原文 + 合法键表），拿回来的 `Check[]` 直接进诊断包。
 * 桌面不适用的检查（工作目录 —— 那是 CLI 的概念）按名字 **skip 掉**：
 * 与其显示一句不成立的现状，不如不显示这一格。
 *
 * ## 不许把密钥写进去
 *
 * 凭据那几格只报 **provider id 与 keyRef 名字**（`hasSecret` 只看"在不在"），
 * 从不读 key 的值 —— 回归里钉了这条（`src/diagnosticsExport.test.ts` 会在
 * 环境里放一个假 key，然后断言它**不出现在**导出的文件里）。
 */

/** IPC 通道名（preload 与主进程共用）。 */
export const DIAG_CHANNEL = {
  export: "diag:export",
} as const;

/** 诊断包落盘目录（与用户产物分开，不混进「产物」列表）。 */
export function diagnosticsDir(): string {
  return path.join(app.getPath("userData"), "diagnostics");
}

/** 桌面不适用的检查（按 `Check.name`）——理由见文件头。 */
const DESKTOP_SKIP = ["工作目录"] as const;

/** 导出的结果：成功给路径，失败给一句人话。 */
export type DiagnosticsExportResult = { ok: true; path: string; bytes: number } | { ok: false; error: string };

/**
 * 组装诊断包（纯组装 + 读一点的 IO；IPC 与测试都调它）。
 *
 * @param now 时间戳（测试传固定值）
 * @returns 包对象与它的 JSON 文本
 */
export function buildDiagnosticsBundle(now: number = Date.now()): { bundle: Record<string, unknown>; json: string; checks: Check[] } {
  const dataDir = app.getPath("userData");
  const configPath = appSettingsPath();

  /* settings.json 原文（不可信：坏了/没有都按"没配"报，不让导出失败） */
  let rawConfig: unknown;
  try {
    rawConfig = JSON.parse(fs.readFileSync(configPath, "utf8"));
  } catch {
    rawConfig = undefined;
  }
  /* 默认通道：settings.json 的 pinnedModel 是 "provider/model"（空串 = 记忆上次） */
  const pinned = typeof (rawConfig as { pinnedModel?: unknown } | undefined)?.pinnedModel === "string"
    ? String((rawConfig as { pinnedModel: string }).pinnedModel)
    : "";
  const [provider, model] = pinned ? pinned.split("/") : [];

  const checks = runDoctor({
    dataDir,
    configPath,
    rawConfig,
    runtime: `${process.platform} ${process.arch} / Electron ${process.versions.electron ?? "?"}（Node ${process.versions.node}）`,
    bunBinary: false,
    versions: { node: process.versions.node },
    config: { normalized: { provider, model }, allowedKeys: APP_SETTINGS_KEYS },
    skip: DESKTOP_SKIP,
  });

  const bundle = {
    kind: "ding-diagnostics",
    at: new Date(now).toISOString(),
    app: {
      version: app.getVersion(),
      electron: process.versions.electron ?? null,
      node: process.versions.node,
      chrome: process.versions.chrome ?? null,
      platform: process.platform,
      arch: process.arch,
      packaged: app.isPackaged,
    },
    paths: {
      userData: dataDir,
      sessionsDb: path.join(dataDir, "sessions.db"),
      assets: path.join(dataDir, "assets"),
    },
    doctor: doctorReport(checks),
  };

  return { bundle, json: JSON.stringify(bundle, null, 2), checks };
}

/**
 * 导出诊断包：写盘 + 在文件管理器里定位，返回真实路径。
 *
 * 文件名带毫秒时间戳（同一秒点两次也不互相覆盖 —— 与生成图同一个教训，审计 P11）。
 */
export function exportDiagnostics(now: number = Date.now()): DiagnosticsExportResult {
  try {
    const { json } = buildDiagnosticsBundle(now);
    const dir = diagnosticsDir();
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `诊断包-${now}.json`);
    fs.writeFileSync(file, json, "utf8");
    shell.showItemInFolder(file);
    return { ok: true, path: file, bytes: Buffer.byteLength(json, "utf8") };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: `诊断包导出失败：${message}` };
  }
}

/** 注册诊断包 IPC。 */
export function registerDiagnosticsIpc(ipcMainInstance: Electron.IpcMain = ipcMain): void {
  ipcMainInstance.handle(DIAG_CHANNEL.export, async (): Promise<DiagnosticsExportResult> => exportDiagnostics());
}
