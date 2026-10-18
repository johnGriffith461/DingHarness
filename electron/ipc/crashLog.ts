import fs from "node:fs";
import path from "node:path";

import { redactSecrets } from "../../shared/redact";

/**
 * **崩溃留痕**（G17 的最后一块：主进程崩了要能查）。
 *
 * ## 之前是什么样
 *
 * `main.ts` 里两个 `process.on(...)` 只把栈写进 `boot.log` —— 而 `boot.log`
 * 不进诊断包，用户"反馈"时导出的包里**看不到崩溃**。于是最该被查的那类问题
 * （一崩就没、复现不了）恰好没有任何证据。
 *
 * ## 三条口径（与 SAFETY 的"不上报"一致）
 *
 * 1. **只落本机**：`<userData>/crashes.jsonl`；**没有任何上传代码** ——
 *    "可选崩溃上报"在这里的诚实形态是"本地留痕 + 用户自己决定给谁"；
 * 2. **过脱敏**：栈和消息里可能带路径或 token（错误信息经常把请求体拼进去），
 *    写盘前一律走 `shared/redact.ts`；
 * 3. **有上限**：只留最近 50 条（超过就截掉最旧的），文件不会无限长。
 *
 * ## 记什么、不记什么
 *
 * 记：时刻、种类（未捕获异常/未处理的拒绝/渲染进程消失/子进程消失）、
 * 错误消息、栈（各截断到 4000 字）、版本、平台。
 * 不记：用户输入、会话正文、任何 key —— 这一层拿不到也不该拿。
 */

/** 崩溃种类。 */
export type CrashKind = "uncaught-exception" | "unhandled-rejection" | "renderer-gone" | "child-process-gone";

/** 一条崩溃记录（落盘的形状）。 */
export type CrashRecord = {
  at: string;
  kind: CrashKind;
  message: string;
  stack?: string;
  version?: string;
  platform?: string;
  /** 渲染进程/子进程消失时的原因（`reason`/`exitCode`）。 */
  detail?: string;
};

/** 最多保留几条（只许少不许多，避免文件随崩溃次数无限长）。 */
export const CRASH_KEEP = 50;
/** 单条消息/栈的截断长度。 */
const MAX_TEXT = 4000;

/** 崩溃文件路径（与诊断包同层，方便一起交出去）。 */
export function crashFileOf(dataDir: string): string {
  return path.join(dataDir, "crashes.jsonl");
}

/** 把任意错误说成 `{message, stack}`（字符串也认）。 */
function describeError(error: unknown): { message: string; stack?: string } {
  if (error instanceof Error) {
    return { message: error.message || String(error), ...(error.stack ? { stack: error.stack } : {}) };
  }
  if (typeof error === "string") return { message: error };
  try {
    return { message: JSON.stringify(error) };
  } catch {
    return { message: String(error) };
  }
}

/**
 * 记一条崩溃（写盘失败**不抛**：崩溃处理器里再抛会变成递归崩溃）。
 *
 * @param dataDir 数据目录
 * @param kind 种类
 * @param error 错误 / 原因
 * @param extra 额外字段（版本、平台、退出码）
 * @returns 写进去的那条（便于测试断言）
 */
export function recordCrash(
  dataDir: string,
  kind: CrashKind,
  error: unknown,
  extra: { version?: string; platform?: string; detail?: string; now?: number } = {},
): CrashRecord {
  const { message, stack } = describeError(error);
  const record: CrashRecord = {
    at: new Date(extra.now ?? Date.now()).toISOString(),
    kind,
    /* 脱敏**在写盘之前**：文件一旦落地就可能被交出去，之后再洗来不及 */
    message: redactSecrets(message).slice(0, MAX_TEXT),
    ...(stack ? { stack: redactSecrets(stack).slice(0, MAX_TEXT) } : {}),
    ...(extra.version ? { version: extra.version } : {}),
    ...(extra.platform ? { platform: extra.platform } : {}),
    ...(extra.detail ? { detail: redactSecrets(extra.detail).slice(0, MAX_TEXT) } : {}),
  };

  const file = crashFileOf(dataDir);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const existing = readCrashLines(file);
    const kept = [...existing, record].slice(-CRASH_KEEP);
    /* 原子写：先写临时文件再改名（与其它落盘同一个保证） */
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, kept.map((one) => JSON.stringify(one)).join("\n") + "\n", "utf8");
    fs.renameSync(tmp, file);
  } catch {
    /* 崩溃处理器里不许再抛 */
  }
  return record;
}

/** 读原始行（坏行跳过 —— 写到一半被打断的那行不该让整份读不出来）。 */
function readCrashLines(file: string): CrashRecord[] {
  if (!fs.existsSync(file)) return [];
  let text = "";
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const out: CrashRecord[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as Partial<CrashRecord>;
      if (typeof parsed?.at !== "string" || typeof parsed?.kind !== "string") continue;
      out.push({
        at: parsed.at,
        kind: parsed.kind as CrashKind,
        message: typeof parsed.message === "string" ? parsed.message : "",
        ...(typeof parsed.stack === "string" ? { stack: parsed.stack } : {}),
        ...(typeof parsed.version === "string" ? { version: parsed.version } : {}),
        ...(typeof parsed.platform === "string" ? { platform: parsed.platform } : {}),
        ...(typeof parsed.detail === "string" ? { detail: parsed.detail } : {}),
      });
    } catch {
      /* 坏行只丢它自己 */
    }
  }
  return out;
}

/**
 * 读最近的崩溃记录（诊断包用）。
 *
 * 返回时再过一次脱敏（防御性：文件可能被手改过）。
 *
 * @param dataDir 数据目录
 * @param limit 最多几条（默认 5 —— 诊断包要能读懂，不是日志转储）
 */
export function recentCrashes(dataDir: string, limit = 5): CrashRecord[] {
  return readCrashLines(crashFileOf(dataDir))
    .slice(-limit)
    .map((one) => ({
      ...one,
      message: redactSecrets(one.message).slice(0, MAX_TEXT),
      ...(one.stack ? { stack: redactSecrets(one.stack).slice(0, MAX_TEXT) } : {}),
    }));
}

/** 清空（用户处置用；诊断包里不提供按钮，走文件即可删）。 */
export function clearCrashes(dataDir: string): void {
  try {
    fs.rmSync(crashFileOf(dataDir), { force: true });
  } catch {
    /* 删不掉也不影响别的 */
  }
}
