import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { UNKNOWN_FAILURE_LINE, uiError } from "./uiError";

/**
 * ⭐ P190：界面出口不许把上游原话贴上来。
 *
 * 修前实测：悬浮助手、版本历史面板这些地方直接 `` `（出错了）${error.message}` ``，
 * 用户看到的是 `ENOENT: no such file or directory, open 'C:\Users\...\kv.db'` 这种
 * 堆栈式文案 —— 而同一句原因在别的通道里早就被 `shared/errors.ts` 翻成
 * 「连不上 provider（检查网络，或本地服务是否已启动）」了。
 *
 * 判据分两半，都是**能算的**：
 *   ① 认得出来 → 给的是 `failureMessage` 那句（含下一步）；
 *   ② **认不出来 → 不给原文**（只说一句统一的话），原文只进控制台。
 */
describe("uiError：上游错误 → 界面上那一句话（P190）", () => {
  it("⭐ 认得出原因：走 `shared/errors.ts` 的口径（含下一步），不是原文", () => {
    const line = uiError(new Error("429 Too Many Requests"));
    expect(line, "限流要说「稍后重试」那种人话").toContain("限流");
    expect(line).toContain("稍后重试");
    expect(line, "裸状态码不许出现在给用户看的文案里").not.toContain("429");
  });

  it("⭐ 认不出来：不许把原文贴上界面（把原文写进日志就行）", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      /* 夹具用示意路径（不带任何"这台机器是谁"的痕迹） */
      const raw = "ENOENT: no such file or directory, open 'C:\\work\\proj\\snapshot.json'";
      const line = uiError(new Error(raw));
      expect(line, "堆栈式文案贴到界面上了").not.toContain("ENOENT");
      expect(line).not.toContain("C:\\work");
      expect(line).toBe(UNKNOWN_FAILURE_LINE);
      expect(spy, "原文要留给排查（日志）").toHaveBeenCalled();
      expect(String(spy.mock.calls[0]?.join(" "))).toContain("ENOENT");
    } finally {
      spy.mockRestore();
    }
  });

  it("连不上 provider 这一类也认得（不是只认 HTTP 状态码）", () => {
    expect(uiError(new Error("fetch failed"))).toContain("连不上");
  });

  it("抛出物不是 Error 也不崩（`unknown` 是这一层的入参类型）", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      expect(uiError("随便一个字符串")).toBe(UNKNOWN_FAILURE_LINE);
      expect(uiError(undefined)).toBe(UNKNOWN_FAILURE_LINE);
      expect(uiError(null)).toBe(UNKNOWN_FAILURE_LINE);
      /* `String()` 自己会抛的东西也不能让界面再炸一次 */
      const evil = { toString: () => { throw new Error("坏掉的 toString"); } };
      expect(uiError(evil)).toBe(UNKNOWN_FAILURE_LINE);
    } finally {
      spy.mockRestore();
    }
  });

  it("「已中止」原样透出（用户自己按的停止，不该被说成「没料到的问题」）", () => {
    expect(uiError(new Error("已中止"))).toBe("已中止");
  });
});

/**
 * 出口守卫：**已经接上 `uiError` 的那几处不许退回原话**（2026-10-16 审计 P190）。
 *
 * 这份名单是"已知的界面出口"，不是"所有出口"—— 新加的界面出口请把文件加进来。
 * （`src/ai/aiClient.ts` 等主进程侧 / 别的模块不在本文件的可改动范围里。）
 */
describe("P190：界面出口不许把 `error.message` 直接拼进给用户看的文案", () => {
  const ROOT = path.resolve(__dirname, "..", "..");
  /** 已知的界面出口（用户看得见的地方）。 */
  const EXITS = [
    "src/workbench/FloatingAssistant.tsx",
    "src/workbench/libraryStore.ts",
    "src/canvas/VersionHistoryPanel.tsx",
    "src/canvas/clipboard.ts",
  ];
  /** 其中"上游原话会真的落到用户眼前"的那几处 —— 它们必须走 `uiError`。 */
  const MUST_USE_UIERROR = [
    "src/workbench/FloatingAssistant.tsx",
    "src/workbench/libraryStore.ts",
    "src/canvas/VersionHistoryPanel.tsx",
  ];

  /** 去注释之后的源码（注释里写"以前是 `${error.message}`"不算泄漏 —— 实测踩过）。 */
  function code(rel: string): string {
    return readFileSync(path.join(ROOT, rel), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
  }

  it("⭐ 这几处都不含 `error.message`（上游原话只许进日志）", () => {
    const offenders: string[] = [];
    for (const rel of EXITS) {
      if (/error\.message|e\.message|err\.message/.test(code(rel))) offenders.push(rel);
    }
    expect(
      offenders,
      "这些界面出口又把上游原话（ENOENT / SDK 堆栈那种）直接贴给用户了 —— 走 `uiError`（P190）",
    ).toEqual([]);
  });

  it("⭐ 该走 `uiError` 的那几处真的提了它（不是把 message 换成另一种拼法）", () => {
    for (const rel of MUST_USE_UIERROR) {
      expect(code(rel), `${rel} 里没有 uiError —— 名单是不是该改/该删条目？`).toContain("uiError");
    }
  });
});
