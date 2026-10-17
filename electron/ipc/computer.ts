import { app, desktopCapturer, dialog, ipcMain, screen, type BrowserWindow } from "electron";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import {
  auditOf,
  buildClickScript,
  buildKeyScript,
  buildTypeScript,
  validateComputerAction,
  type ComputerAction,
  type ComputerAuditEntry,
  type ComputerKey,
} from "../../shared/computer";

/**
 * Computer Use 的执行层（V6-2n，Windows）。
 *
 * ## 三层门（缺一不可）
 *
 * 1. **授权**：`computer-use.json` 的 `enabled`（默认 false）；
 * 2. **审批**：界面发起的动作每次都弹原生确认；agent 发起的走工具闸门
 *    （`computer_*` 在策略表里是 `write`，按需确认档下会停下来问）；
 * 3. **留痕**：成功/失败/被拒都写 `computer-use.jsonl`；**输入的文字不记录**。
 *
 * ## 沙箱（如实说）
 *
 * Windows 上没有 OS 级"只许操作某个窗口"的沙箱：这里是**授权 + 审批 + 留痕**，
 * 加上坐标必须落在屏幕内、按键白名单、输入长度上限。不做"假装有隔离"。
 *
 * ## 平台
 *
 * 执行只用 Windows（user32 SendInput/SendKeys）。macOS/Linux 返回明确错误
 * （macOS 的无障碍树路线未做；不写一个跑不起来的壳）。
 */

export const COMPUTER_CHANNEL = {
  status: "computer:status",
  enable: "computer:enable",
  disable: "computer:disable",
  screenshot: "computer:screenshot",
  click: "computer:click",
  type: "computer:type",
  key: "computer:key",
  log: "computer:log",
} as const;

export type ComputerState = { enabled: boolean };

function stateFile(): string {
  return path.join(app.getPath("userData"), "computer-use.json");
}
function auditFile(): string {
  return path.join(app.getPath("userData"), "computer-use.jsonl");
}

/** 读授权状态（默认关；坏文件也按关处理）。 */
export function readComputerState(): ComputerState {
  try {
    const raw = JSON.parse(fs.readFileSync(stateFile(), "utf8")) as { enabled?: unknown };
    return { enabled: raw.enabled === true };
  } catch {
    return { enabled: false };
  }
}

/** 写授权状态（原子）。 */
export function writeComputerState(state: ComputerState): void {
  fs.mkdirSync(path.dirname(stateFile()), { recursive: true });
  const tmp = `${stateFile()}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  fs.renameSync(tmp, stateFile());
}

function audit(action: ComputerAction, ok: boolean, detail: string): void {
  try {
    fs.mkdirSync(path.dirname(auditFile()), { recursive: true });
    fs.appendFileSync(auditFile(), `${JSON.stringify(auditOf(action, ok, detail))}\n`, "utf8");
  } catch {
    /* 留痕失败不影响动作本身；但不能静默到完全没有痕迹 —— 至少写 stderr */
    console.error("[computer] 审计写入失败");
  }
}

/** 最近的审计条目（界面展示用）。 */
export function readComputerLog(limit = 30): ComputerAuditEntry[] {
  try {
    return fs
      .readFileSync(auditFile(), "utf8")
      .split("\n")
      .filter(Boolean)
      .slice(-limit)
      .map((line) => JSON.parse(line) as ComputerAuditEntry)
      .filter((x) => typeof x?.at === "number");
  } catch {
    return [];
  }
}

/** 给审批对话框看的一句话（**不包含输入的文字**）。 */
export function describeComputerAction(action: ComputerAction): string {
  switch (action.kind) {
    case "screenshot":
      return "截取当前屏幕";
    case "click":
      return `在 (${action.x}, ${action.y}) ${action.button === "right" ? "右" : "左"}键点击`;
    case "type":
      return `输入 ${action.text.length} 个字符（内容不显示、不记录）`;
    case "key":
      return `按下 ${action.key}`;
  }
}

export type ComputerResult =
  | { ok: true; detail: string; path?: string; dataUrl?: string; width?: number; height?: number }
  | { ok: false; error: string };

/**
 * 执行一次动作（**调用方必须先完成授权与审批**）。
 *
 * @param action 动作
 * @param opts.requireEnabled 是否再检查一次授权（工具那条要；界面已经过了开关）
 */
export async function runComputerAction(action: ComputerAction, opts: { requireEnabled?: boolean; approvedBy: string }): Promise<ComputerResult> {
  const state = readComputerState();
  if (opts.requireEnabled !== false && !state.enabled) {
    audit(action, false, "未授权（computer-use 关闭）");
    return { ok: false, error: "电脑操作没有授权：先在「权限矩阵」页打开（默认关闭）" };
  }
  const size = screen.getPrimaryDisplay().size;
  const invalid = validateComputerAction(action, size);
  if (invalid) {
    audit(action, false, invalid);
    return { ok: false, error: invalid };
  }

  try {
    if (action.kind === "screenshot") {
      const sources = await desktopCapturer.getSources({
        types: ["screen"],
        thumbnailSize: { width: Math.min(1600, size.width), height: Math.min(1000, size.height) },
      });
      const primary = sources[0];
      if (!primary) throw new Error("没有拿到屏幕源（系统权限？）");
      const image = primary.thumbnail;
      const png = image.toPNG();
      const dir = path.join(app.getPath("userData"), "artifacts", "screens");
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `computer-${Date.now()}.png`);
      fs.writeFileSync(file, png);
      const { width, height } = image.getSize();
      audit(action, true, `截图 ${width}×${height}（${file}）`);
      return { ok: true, detail: `截图 ${width}×${height}`, path: file, dataUrl: image.toDataURL(), width, height };
    }

    if (process.platform !== "win32") {
      const error = "电脑操作目前只实现了 Windows（macOS 的无障碍树路线未做；不假装支持）";
      audit(action, false, error);
      return { ok: false, error };
    }

    const script =
      action.kind === "click" ? buildClickScript(action) : action.kind === "type" ? buildTypeScript(action.text) : buildKeyScript(action.key);
    execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script], {
      timeout: 15_000,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const detail = describeComputerAction(action) + `（批准：${opts.approvedBy}）`;
    audit(action, true, detail);
    return { ok: true, detail };
  } catch (error) {
    const message = String((error as Error)?.message ?? error).slice(0, 200);
    audit(action, false, message);
    return { ok: false, error: message };
  }
}

/** 界面发起的动作：先弹原生确认（默认"取消"）。 */
async function confirm(win: BrowserWindow | null, action: ComputerAction): Promise<boolean> {
  const options = {
    type: "warning" as const,
    buttons: ["取消", "允许这一次"],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
    title: "允许一次电脑操作？",
    message: describeComputerAction(action),
    detail: "这会操作你的真实桌面（鼠标/键盘/屏幕）。内容不记录；每次都要重新批准。",
  };
  const result = win ? await dialog.showMessageBox(win, options) : await dialog.showMessageBox(options);
  return result.response === 1;
}

export function registerComputerIpc(getWindow: () => BrowserWindow | null): void {
  ipcMain.handle(COMPUTER_CHANNEL.status, () => {
    const state = readComputerState();
    return {
      enabled: state.enabled,
      platform: process.platform,
      supported: process.platform === "win32",
      log: readComputerLog(20),
    };
  });

  ipcMain.handle(COMPUTER_CHANNEL.enable, async () => {
    const win = getWindow();
    const options = {
      type: "warning" as const,
      buttons: ["取消", "我了解风险，授权"],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
      title: "授权电脑操作？",
      message: "允许 Ding 截屏、移动鼠标、点击与输入吗？",
      detail:
        "授权后，agent 在你批准每一次动作时可以操作真实桌面。默认关闭，随时可关。\n" +
        "限制：坐标必须在屏幕内、按键白名单、单次输入 ≤4000 字符；每个动作都会留痕（不记录输入内容）。\n" +
        "这不是操作系统级沙箱。",
    };
    const result = win ? await dialog.showMessageBox(win, options) : await dialog.showMessageBox(options);
    if (result.response !== 1) return { ok: false, error: "未授权" };
    writeComputerState({ enabled: true });
    return { ok: true, enabled: true };
  });

  ipcMain.handle(COMPUTER_CHANNEL.disable, () => {
    writeComputerState({ enabled: false });
    return { ok: true, enabled: false };
  });

  const guarded = async (action: ComputerAction) => {
    if (!readComputerState().enabled) return { ok: false, error: "电脑操作没有授权（默认关闭）" };
    if (!(await confirm(getWindow(), action))) {
      audit(action, false, "用户取消");
      return { ok: false, error: "已取消" };
    }
    return runComputerAction(action, { approvedBy: "user" });
  };

  ipcMain.handle(COMPUTER_CHANNEL.screenshot, () => guarded({ kind: "screenshot" }));
  ipcMain.handle(COMPUTER_CHANNEL.click, (_e, raw: unknown) => {
    const r = (raw ?? {}) as { x?: unknown; y?: unknown; button?: unknown };
    return guarded({
      kind: "click",
      x: Number(r.x),
      y: Number(r.y),
      ...(r.button === "right" || r.button === "left" ? { button: r.button } : {}),
    });
  });
  ipcMain.handle(COMPUTER_CHANNEL.type, (_e, text: unknown) => guarded({ kind: "type", text: String(text ?? "") }));
  ipcMain.handle(COMPUTER_CHANNEL.key, (_e, key: unknown) => guarded({ kind: "key", key: String(key ?? "") as ComputerKey }));
  ipcMain.handle(COMPUTER_CHANNEL.log, () => readComputerLog(30));
}
