import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { formatDoctor, runDoctor, type Check } from "./doctor";

/**
 * `ding doctor` 的验收（Phase 11.4）。
 *
 * 方案那条硬要求是「**失败项 100% 带 actionable 指引**」。它是**结构上**保证的：
 * `Check.next` 是必填字段，不写下一步编译不过。所以这里验的是**另一半**：
 * 那几句 next 在**真的失败时**确实出现了，而且说得具体（不是空话）。
 *
 * 另外顺带验"它不改用户的机器"：只做一次探针写入，写完就删。
 */

const tmpDirs: string[] = [];
afterEach(() => {
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function freshDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dh-doctor-"));
  tmpDirs.push(dir);
  return dir;
}

/** 干净环境：不读真实凭据（这几条都不该碰用户的 key）。 */
function cleanEnv<T>(fn: () => T): T {
  const saved: Record<string, string | undefined> = {};
  const names = ["DEEPSEEK_API_KEY", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_API_KEY", "A_API_KEY", "STRATA_API_KEY"];
  for (const n of names) {
    saved[n] = process.env[n];
    delete process.env[n];
  }
  const prevPath = process.env.DSH_CREDENTIALS_FILE;
  // 把凭据文件指到一个不存在的路径（`credentials.ts` 认这个变量）
  process.env.DSH_CREDENTIALS_FILE = path.join(freshDir(), "none.yaml");
  try {
    return fn();
  } finally {
    for (const n of names) if (saved[n] !== undefined) process.env[n] = saved[n]!;
    if (prevPath === undefined) delete process.env.DSH_CREDENTIALS_FILE;
    else process.env.DSH_CREDENTIALS_FILE = prevPath;
  }
}

function doctorWith(dataDir: string, rawConfig: unknown = {}): Check[] {
  return cleanEnv(() =>
    runDoctor({
      dataDir,
      configPath: path.join(dataDir, "config.json"),
      rawConfig,
      runtime: "test",
      bunBinary: false,
    }),
  );
}

describe("ding doctor（Phase 11.4）", () => {
  it("① 每条检查都有下一步（过了也要写「不用做什么」）", () => {
    const checks = doctorWith(freshDir());
    expect(checks.length).toBeGreaterThanOrEqual(8);
    for (const c of checks) {
      expect(c.next.trim().length, `「${c.name}」没有下一步`).toBeGreaterThan(0);
      expect(c.detail.trim().length, `「${c.name}」没有说明现状`).toBeGreaterThan(0);
      /*
       * 判据分两种（这才是方案那句话的落点）：
       *   · **失败项**的下一步必须是**动作**（提到命令 / 文件 / 具体该改什么）；
       *   · 通过项的下一步只需说清"不用做什么"（"无需处理"是合法的）。
       * 一律要求动作词会逼出"为了过检查而凑一句话"的写法。
       */
      if (!c.ok) {
        expect(
          /(ding |DH_DATA_DIR|pnpm |config |credentials|环境变量|删掉|换|检查|备份|改名|设)/.test(c.next),
          `失败项「${c.name}」的下一步不像可执行的动作：${c.next}`,
        ).toBe(true);
      }
    }
  });

  it("② 全新机器：凭据那格必须红，且给的是「怎么做」而不是「出错了」", () => {
    const checks = doctorWith(freshDir());
    const cred = checks.find((c) => c.name === "模型凭据");
    expect(cred, "没有「模型凭据」这一格").toBeTruthy();
    expect(cred!.ok, "干净环境下凭据竟然判成可用").toBe(false);
    // 指引要**可执行**：提到具体命令或具体文件
    expect(/ding init|credentials|环境变量|\.dsh/.test(cred!.next), `指引太空：${cred!.next}`).toBe(true);
  });

  it("③ 配置里写了不认识的档位：这一格红，且说清可选值", () => {
    const checks = doctorWith(freshDir(), { mode: "随便写写" });
    const cfg = checks.find((c) => c.name === "配置文件合法");
    expect(cfg?.ok).toBe(false);
    expect(cfg!.next).toContain("全部允许");
    expect(cfg!.next).toContain("按需确认");
  });

  it("④ 配了不存在的工作目录：这一格红（否则工具会一律报「不在可写范围内」）", () => {
    const missing = path.join(os.tmpdir(), "dh-does-not-exist-" + Date.now());
    const checks = doctorWith(freshDir(), { dirs: [missing] });
    const dirs = checks.find((c) => c.name === "工作目录");
    expect(dirs?.ok).toBe(false);
    expect(dirs!.detail).toContain(missing);
    expect(/删掉|改对|unset/.test(dirs!.next)).toBe(true);
  });

  it("⑤ 命令隔离那一格：有沙箱说清楚、没沙箱也**如实说没有**（不装）", () => {
    const checks = doctorWith(freshDir());
    const box = checks.find((c) => c.name === "命令隔离");
    expect(box, "没有「命令隔离」这一格").toBeTruthy();
    /*
     * 判据是"**说的是实话**"，不是"一定没有沙箱"：
     * Phase 14.1 之后本机（Windows）**可能真的编了沙箱**，那时它该报"有上限、不留孤儿"，
     * 而**同时**必须说清"不是安全边界"。两种情况都要能过 —— 这一格不是"有没有"，是"实不实"。
     */
    expect(box!.detail.length).toBeGreaterThan(10);
    if (/作业对象|上限/.test(box!.detail)) {
      expect(box!.detail, "有沙箱时必须说清它不是安全边界").toMatch(/不是安全边界|仍以你的身份/);
    } else {
      expect(box!.detail).toMatch(/没有沙箱|同权限/);
    }
  });

  it("⑥ 只报告、不动机器：探针文件写完就删", () => {
    const dir = freshDir();
    doctorWith(dir);
    const left = fs.readdirSync(dir).filter((f) => f.includes("doctor-probe"));
    expect(left, "doctor 在数据目录里留下了东西").toEqual([]);
  });

  it("⑦ `--json` 的形状：ok / failed / checks 三件都在", () => {
    const checks = doctorWith(freshDir());
    const parsed = JSON.parse(formatDoctor(checks, { json: true })) as {
      ok: boolean;
      failed: number;
      checks: Check[];
    };
    expect(typeof parsed.ok).toBe("boolean");
    expect(parsed.failed).toBe(checks.filter((c) => !c.ok).length);
    expect(parsed.checks.length).toBe(checks.length);
    // 给人看的那份要带"下一步"这一行
    const text = formatDoctor(checks, { json: false });
    expect(text).toContain("ding doctor");
    if (parsed.failed > 0) expect(text).toContain("下一步：");
  });
});
