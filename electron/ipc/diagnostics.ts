import fs from "node:fs";
import path from "node:path";
import { app, ipcMain, shell } from "electron";

import { doctorReport, runDoctor, type Check } from "../../engine/runtime/doctor";
import { openSqlite } from "../../engine/adapters/sqliteDriver";
import { recentCrashes } from "./crashLog";
import { redactSecrets } from "../../shared/redact";
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
  /** 预览：组装同一份包并把文本交回渲染层（**不写盘**）。 */
  preview: "diag:preview",
} as const;

/** 诊断包落盘目录（与用户产物分开，不混进「产物」列表）。 */
export function diagnosticsDir(): string {
  return path.join(app.getPath("userData"), "diagnostics");
}

/** 桌面不适用的检查（按 `Check.name`）——理由见文件头。 */
const DESKTOP_SKIP = ["工作目录"] as const;

/** 导出的结果：成功给路径，失败给一句人话。 */
export type DiagnosticsExportResult = { ok: true; path: string; bytes: number } | { ok: false; error: string };

/** 预览的结果：同一份文本（已脱敏）+ 一句范围说明。 */
export type DiagnosticsPreviewResult =
  | { ok: true; json: string; bytes: number; note: string }
  | { ok: false; error: string };

/** 最近事件里保留的字段（**不含正文**）。 */
export type RecentEventLine = {
  at: string;
  session: string;
  type: string;
  /** 工具名（tool-call / tool-result 才有）。 */
  tool?: string;
  /** 这一步成功与否（tool-result 才有；`pending` 单独标）。 */
  ok?: boolean;
  pending?: boolean;
  /** 运行态（run-state 才有）。 */
  state?: string;
};

/**
 * **最近事件摘要**（G17 的"最近事件"那一格）。
 *
 * ⚠️ 只取类型与元信息，**不取正文**（`events.body` 与 `payload.text` 一律不读）：
 * 诊断包要给第三方看，"用户说了什么"不在里面。这条与文件头的红线一致。
 *
 * 读不动（库不存在 / 没这张表 / 老版本）时返回空数组 + 一句说明 ——
 * 诊断包本身绝不能因为"读不到最近事件"而导出失败。
 *
 * @param dataDir 数据目录
 * @param limit 最多几条
 */
export function recentActivity(dataDir: string, limit = 40): { events: RecentEventLine[]; note?: string } {
  const file = path.join(dataDir, "sessions.db");
  if (!fs.existsSync(file)) return { events: [], note: "还没有会话库（首次使用或已清理）" };
  let db;
  try {
    db = openSqlite(file);
  } catch (error) {
    return { events: [], note: `会话库打不开：${String((error as Error)?.message ?? error).slice(0, 120)}` };
  }
  try {
    const rows = db
      .prepare("SELECT session_id, at, type, payload FROM events ORDER BY at DESC LIMIT ?")
      .all(limit) as Array<{ session_id?: unknown; at?: unknown; type?: unknown; payload?: unknown }>;
    const events: RecentEventLine[] = [];
    for (const row of rows) {
      const type = typeof row.type === "string" ? row.type : "";
      if (!type) continue;
      let payload: Record<string, unknown> = {};
      try {
        payload = JSON.parse(String(row.payload ?? "{}")) as Record<string, unknown>;
      } catch {
        /* 坏行只丢它自己 */
      }
      const tool = typeof payload.toolName === "string" ? payload.toolName : typeof payload.name === "string" ? payload.name : undefined;
      const line: RecentEventLine = {
        at: new Date(Number(row.at ?? 0)).toISOString(),
        session: String(row.session_id ?? "").slice(0, 64),
        type,
        ...(tool ? { tool } : {}),
        ...(type === "tool-result" ? { ok: payload.error === undefined, ...(payload.pending === true ? { pending: true } : {}) } : {}),
        ...(type === "run-state" && typeof payload.state === "string" ? { state: payload.state } : {}),
      };
      events.push(line);
    }
    return { events };
  } catch (error) {
    return { events: [], note: `最近事件读不出来：${String((error as Error)?.message ?? error).slice(0, 120)}` };
  } finally {
    db.close();
  }
}

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
    /* G17「最近事件」：只放类型与元信息（**不含正文**）；读不动时 note 说明原因 */
    recent: recentActivity(dataDir),
    /* G17「崩溃留痕」：最近 5 条（已脱敏，只落本机、从不上传） */
    crashes: recentCrashes(dataDir, 5),
    doctor: doctorReport(checks),
  };

  /*
   * U14：整包再过一道脱敏。诊断包是**要给第三方看**的（用户贴给帮忙的人），
   * 而 doctor 的某些说明里可能带着上游原文或用户命令 —— 兜底比"记得别写进去"可靠。
   */
  return { bundle, json: redactSecrets(JSON.stringify(bundle, null, 2)), checks };
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

/**
 * **预览诊断包**（G17："用户可预览内容"）：组装与导出**同一份**文本，但不写盘。
 *
 * 为什么必须复用 `buildDiagnosticsBundle`：预览要是另拼一份，用户看到的与被导出的
 * 就不是同一份东西 —— 那比"不能预览"更坏（他会以为删掉了某段，实际导出的还有）。
 */
export function previewDiagnostics(now: number = Date.now()): DiagnosticsPreviewResult {
  try {
    const { json } = buildDiagnosticsBundle(now);
    return {
      ok: true,
      json,
      bytes: Buffer.byteLength(json, "utf8"),
      note: "这是要导出的全部内容（已脱敏）：不含密钥值，最近事件只有类型与工具名、不含对话正文。",
    };
  } catch (error) {
    return { ok: false, error: `诊断包组装失败：${error instanceof Error ? error.message : String(error)}` };
  }
}

/** 注册诊断包 IPC。 */
export function registerDiagnosticsIpc(ipcMainInstance: Electron.IpcMain = ipcMain): void {
  ipcMainInstance.handle(DIAG_CHANNEL.export, async (): Promise<DiagnosticsExportResult> => exportDiagnostics());
  ipcMainInstance.handle(DIAG_CHANNEL.preview, async (): Promise<DiagnosticsPreviewResult> => previewDiagnostics());
}
