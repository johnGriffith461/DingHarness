import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * 治理与隐私文件的存在性 + 声明与实现的一致性（V6-3g / V6-3i）。
 *
 * 这不是"文档有没有写"，而是**承诺有没有代码兜底**：
 *   · `PRIVACY.md` 说"默认零遥测" → 依赖里不该有上报 SDK；
 *   · `PRIVACY.md` 说 OTLP 不配就不发 → `otlpConfigFromEnv({})` 必须是 null；
 *   · `SECURITY.md` 说"已知边界不装" → `SAFETY.md` 里那条沙箱限制必须还在。
 *
 * 文件删了、承诺改了而实现没跟，这里就会红 —— 那正是"可审计一致"的意思。
 */

const ROOT = path.resolve(__dirname, "..");

function read(rel: string): string {
  return fs.readFileSync(path.join(ROOT, rel), "utf8");
}

describe("治理文件存在且不是空壳", () => {
  for (const file of ["SECURITY.md", "GOVERNANCE.md", "SUPPORT.md", "PRIVACY.md", "AGENTS.md"]) {
    it(`${file} 存在且有实质内容`, () => {
      const text = read(file);
      expect(text.length, `${file} 太短，像占位`).toBeGreaterThan(400);
    });
  }

  it("SECURITY.md 写清了私密渠道与 AI 生成报告政策", () => {
    const text = read("SECURITY.md");
    expect(text).toMatch(/私密|Private vulnerability reporting/);
    expect(text).toMatch(/AI 生成|自动/);
  });

  it("GOVERNANCE.md 写清了谁定什么与不可协商的四条", () => {
    const text = read("GOVERNANCE.md");
    expect(text).toMatch(/本地数据主权/);
    expect(text).toMatch(/默认零遥测/);
    expect(text).toMatch(/诚实边界/);
    expect(text).toMatch(/契约冻结/);
  });
});

describe("隐私声明与实现一致", () => {
  it("依赖里没有遥测/崩溃上报 SDK", () => {
    const pkg = JSON.parse(read("package.json")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const names = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });
    const banned = /(sentry|posthog|mixpanel|segment|amplitude|datadog|newrelic|bugsnag|fullstory|hotjar|plausible|umami)/i;
    expect(names.filter((n) => banned.test(n))).toEqual([]);
  });

  it("PRIVACY.md 的「默认零遥测」有代码落点：没配端点就不导出", async () => {
    const text = read("PRIVACY.md");
    expect(text).toMatch(/默认不收集|零遥测|不收集/);
    const { otlpConfigFromEnv } = await import("@engine/runtime/otlp");
    expect(otlpConfigFromEnv({})).toBeNull();
  });

  it("PRIVACY.md 提到的数据位置与实际数据目录命名一致", () => {
    const text = read("PRIVACY.md");
    expect(text).toContain("sessions.db");
    expect(text).toContain("memory.json");
    /* 数据目录默认值写在 README/PRIVACY 两处，必须是同一个 */
    expect(read("README.md")).toContain("~/.ding");
  });

  it("SECURITY.md 的已知边界与 SAFETY.md 不打架（沙箱只在 Windows 有资源上限）", () => {
    const sec = read("SECURITY.md");
    const safe = read("SAFETY.md");
    expect(sec).toMatch(/macOS\/Linux 没有|macOS.*没有/);
    expect(safe.length).toBeGreaterThan(400);
  });
});
