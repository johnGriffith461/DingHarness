import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { removeAll } from "./testFs";

/**
 * 诊断包导出（2026-10-17，V5 开工前清尾 §2.4 #7）—— 主进程那半。
 *
 * 范式与 `src/ipcStores.test.ts` 一致：**mock electron + 临时 userData + 真读盘**。
 * 三件必须钉住的事：
 *   ① 文件**真的写出来**且是合法 JSON（含 app / 路径 / doctor 三块）；
 *   ② **密钥值不许进包**（只在环境里放一把假 key：凭据那格必须"看见了"它
 *      —— detail 里出现 deepseek —— 而包全文**不含**那把 key 的值）；
 *   ③ 桌面不适用/适用的检查项按口径取舍：`工作目录` 被 skip，
 *      settings.json 原文里的坏键真的会被「配置文件合法」那格报出来。
 */

const env = vi.hoisted(() => ({ userData: "", reveal: [] as string[] }));

vi.mock("electron", () => ({
  app: {
    getPath: () => env.userData,
    getVersion: () => "0.0.0-test",
    isPackaged: false,
  },
  ipcMain: { handle: () => undefined },
  shell: {
    showItemInFolder: (file: string) => {
      env.reveal.push(file);
    },
  },
}));

import { appSettingsPath } from "../electron/ipc/appSettings";
import { buildDiagnosticsBundle, diagnosticsDir, exportDiagnostics } from "../electron/ipc/diagnostics";

let tmpRoot = "";
/** 假凭据文件（不指向真实那份）+ 一把假 key（用完一定清掉）。 */
let prevKey: string | undefined;
let prevCredFile: string | undefined;

beforeEach(() => {
  tmpRoot = mkdtempSync(path.join(os.tmpdir(), "dh-diagtest-"));
  env.userData = tmpRoot;
  env.reveal.length = 0;
  prevKey = process.env.DEEPSEEK_API_KEY;
  prevCredFile = process.env.DSH_CREDENTIALS_FILE;
  process.env.DEEPSEEK_API_KEY = "sk-test-SECRET-VALUE-123";
  process.env.DSH_CREDENTIALS_FILE = path.join(tmpRoot, "none.yaml");
});

afterEach(() => {
  if (prevKey === undefined) delete process.env.DEEPSEEK_API_KEY;
  else process.env.DEEPSEEK_API_KEY = prevKey;
  if (prevCredFile === undefined) delete process.env.DSH_CREDENTIALS_FILE;
  else process.env.DSH_CREDENTIALS_FILE = prevCredFile;
  if (tmpRoot) removeAll(tmpRoot);
  tmpRoot = "";
});

describe("诊断包导出（主进程侧）", () => {
  it("⭐ 写盘 + 定位：文件在、是合法 JSON、app/paths/doctor 三块齐", () => {
    const got = exportDiagnostics(1_760_000_000_000);
    expect(got.ok).toBe(true);
    if (!got.ok) return;

    expect(got.path.startsWith(diagnosticsDir())).toBe(true);
    expect(got.bytes).toBeGreaterThan(100);

    const text = readFileSync(got.path, "utf8");
    const bundle = JSON.parse(text) as {
      kind: string;
      at: string;
      app: { version: string; electron: unknown };
      paths: { userData: string; sessionsDb: string };
      doctor: { ok: boolean; failed: number; checks: Array<{ name: string; ok: boolean; detail: string }> };
    };
    expect(bundle.kind).toBe("ding-diagnostics");
    expect(bundle.at).toBe(new Date(1_760_000_000_000).toISOString());
    expect(bundle.app.version).toBe("0.0.0-test");
    expect(bundle.paths.userData).toBe(tmpRoot);
    expect(bundle.paths.sessionsDb).toContain("sessions.db");
    expect(bundle.doctor.checks.length).toBeGreaterThan(5);
    expect(bundle.doctor.failed).toBe(bundle.doctor.checks.filter((c) => !c.ok).length);

    /* 主进程真的去文件管理器里定位了（不然用户不知道包在哪） */
    expect(env.reveal).toEqual([got.path]);
  });

  it("⭐ 凭据那格看得见假 key（说明真读了）——而**密钥值本身不进包**", () => {
    const { json } = buildDiagnosticsBundle();
    /* 看见了：凭据那一格把 deepseek 列进"可用" */
    expect(json).toContain("deepseek");
    /* 值没进包：假 key 的值整串不许出现（doctor 只报 id 与 keyRef 名字） */
    expect(json).not.toContain("SECRET-VALUE-123");
  });

  it("桌面口径：`工作目录` 被 skip（不是判成绿），settings.json 坏键会被报出来", () => {
    const plain = buildDiagnosticsBundle();
    expect(plain.checks.some((c) => c.name === "工作目录")).toBe(false);

    /* 手写进 settings.json 的坏键：normalize 会静默丢掉，诊断包要替用户看见它 */
    writeFileSync(appSettingsPath(), JSON.stringify({ pinnedModel: "deepseek/deepseek-chat", 手误的键: 1 }), "utf8");
    const { checks } = buildDiagnosticsBundle();
    const cfg = checks.find((c) => c.name === "配置文件合法");
    expect(cfg?.ok, "settings.json 里的坏键没有被报出来").toBe(false);
    expect(cfg!.detail).toContain("手误的键");
  });

  it("settings.json 里的默认通道会被当成默认 provider/模型 去查（不是编的）", () => {
    writeFileSync(appSettingsPath(), JSON.stringify({ pinnedModel: "deepseek/deepseek-chat" }), "utf8");
    const { checks, json } = buildDiagnosticsBundle();
    const prov = checks.find((c) => c.name === "默认 provider");
    expect(prov?.detail).toContain("deepseek");
    const model = checks.find((c) => c.name === "默认模型");
    expect(model?.detail).toContain("deepseek-chat");
    expect(json).not.toContain("SECRET-VALUE-123");
  });
});
