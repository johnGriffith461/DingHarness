import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CRASH_KEEP, crashFileOf, clearCrashes, recordCrash, recentCrashes } from "../electron/ipc/crashLog";

/**
 * **崩溃留痕**（G17）的判据。
 *
 * 之前主进程崩了只写 `boot.log`，诊断包里看不到 —— 最该被查的问题恰好没证据。
 * 这里钉四件事：
 * ① 记进去、读得回来（种类/消息/栈/版本/平台）；
 * ② **写盘前脱敏**（错误信息里常有 token）；
 * ③ 条数有上限（不会随崩溃次数无限长）；
 * ④ 坏行只丢它自己（写到一半被打断不该让整份读不出来）。
 */

let dir = "";

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "dh-crash-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("recordCrash / recentCrashes", () => {
  it("记一条能读回来（含栈与版本）", () => {
    const record = recordCrash(dir, "uncaught-exception", new Error("炸了"), {
      version: "0.5.1",
      platform: "win32 x64",
      now: 1_760_000_000_000,
    });
    expect(record.at).toBe(new Date(1_760_000_000_000).toISOString());
    expect(record.kind).toBe("uncaught-exception");

    const back = recentCrashes(dir);
    expect(back).toHaveLength(1);
    expect(back[0]).toMatchObject({ kind: "uncaught-exception", message: "炸了", version: "0.5.1", platform: "win32 x64" });
    expect(back[0]!.stack).toContain("炸了");
  });

  it("⭐ 写盘前就脱敏（token 不进文件）", () => {
    recordCrash(dir, "unhandled-rejection", new Error("请求失败：Authorization: Bearer sk-live-abcdef1234567890"));
    const raw = readFileSync(crashFileOf(dir), "utf8");
    expect(raw, "脱敏只在读的时候做、文件里还留着原样").not.toContain("sk-live-abcdef1234567890");
    expect(raw).toContain("请求失败");
  });

  it("字符串/对象也认（不只是 Error）", () => {
    recordCrash(dir, "renderer-gone", "crashed");
    recordCrash(dir, "child-process-gone", { code: 3 }, { detail: "type=Utility reason=crashed exitCode=3" });
    const back = recentCrashes(dir);
    expect(back.map((c) => c.kind)).toEqual(["renderer-gone", "child-process-gone"]);
    expect(back[1]!.detail).toContain("exitCode=3");
  });

  it("条数有上限（只留最近 CRASH_KEEP 条）", () => {
    for (let i = 0; i < CRASH_KEEP + 10; i += 1) {
      recordCrash(dir, "uncaught-exception", new Error(`第 ${i} 次`));
    }
    const all = recentCrashes(dir, 10_000);
    expect(all).toHaveLength(CRASH_KEEP);
    expect(all.at(-1)!.message).toBe(`第 ${CRASH_KEEP + 9} 次`);
    expect(all[0]!.message, "最旧的没有被截掉").toBe("第 10 次");
  });

  it("recentCrashes 的 limit 生效（诊断包只要最近 5 条）", () => {
    for (let i = 0; i < 8; i += 1) recordCrash(dir, "uncaught-exception", new Error(`e${i}`));
    expect(recentCrashes(dir, 5).map((c) => c.message)).toEqual(["e3", "e4", "e5", "e6", "e7"]);
  });

  it("坏行只丢它自己", () => {
    recordCrash(dir, "uncaught-exception", new Error("好的"));
    const file = crashFileOf(dir);
    writeFileSync(file, `${readFileSync(file, "utf8")}{ 这不是 JSON\n`, "utf8");
    expect(recentCrashes(dir)).toHaveLength(1);
  });

  it("没有文件时是空数组（不是报错）", () => {
    expect(recentCrashes(dir)).toEqual([]);
  });

  it("clearCrashes 之后读不到", () => {
    recordCrash(dir, "uncaught-exception", new Error("x"));
    clearCrashes(dir);
    expect(recentCrashes(dir)).toEqual([]);
  });

  it("⚠️ 没有任何上传代码（只落本机）", () => {
    const src = readFileSync(path.resolve(__dirname, "..", "electron", "ipc", "crashLog.ts"), "utf8");
    expect(src).not.toMatch(/fetch\(|https?:\/\//);
  });
});

/**
 * 装配守卫（源码级）：崩溃处理器**真的**调了记录，而不是只在模块里躺着。
 */
describe("装配：main.ts 把崩溃记下来", () => {
  const main = readFileSync(path.resolve(__dirname, "..", "electron", "main.ts"), "utf8");

  it("uncaughtException / unhandledRejection 都调了 recordCrash", () => {
    expect(main).toContain("recordEverywhere(\"uncaught-exception\", error)");
    expect(main).toContain("recordEverywhere(\"unhandled-rejection\", reason)");
    expect(main).toContain("recordCrash(dir, kind, error");
  });

  it("渲染进程消失与子进程消失也接上了", () => {
    expect(main, "没有 render-process-gone —— 白屏只留白").toContain("\"render-process-gone\"");
    expect(main, "没有 child-process-gone —— 连接器死了查不到").toContain("\"child-process-gone\"");
    expect(main).toContain("recordCrash(dir, \"renderer-gone\"");
    expect(main).toContain("recordCrash(dir, \"child-process-gone\"");
  });

  it("诊断包把崩溃读进去了", () => {
    const diag = readFileSync(path.resolve(__dirname, "..", "electron", "ipc", "diagnostics.ts"), "utf8");
    expect(diag).toContain("recentCrashes(");
    expect(diag).toContain("crashes:");
  });
});
