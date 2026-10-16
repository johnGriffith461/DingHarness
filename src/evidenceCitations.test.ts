import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * 「保真依据」必须能复核，或者**如实标注不能复核**（2026-10-16，审计 G34/G35）。
 *
 * ## 它挡的是什么
 *
 * 全仓有 **30 多处**注释写着"文案逐字取自 `docs/evidence-xxx.txt`"、
 * "期望值抄自 `lunora-image-size-rules.md`"、"实测见 `.verify/measure-theme.py`" ——
 * 而那些文件**从未入库**（`docs/` 被 gitignore）、**本机也找不到**。
 * 后果：读的人以为有据可查，其实**无法复核**；断言于是成了"抄自一个不存在的东西"的自我确认。
 * （审计 G34 把它判为 high：13 个测试文件都建在这套口径上。）
 *
 * 判定：出现这些路径的**每一行**，要么带上 `无法复核` 的如实标注，要么指向仓里真有的东西。
 * ⚠️ 顺带盯一类更坏的：注释指向**仓内**的某个文件、而那个文件不存在（G35 的形状：
 * `shared/contextWindow.ts` / `src/contextWindow.test.ts` 压根没有这个文件）。
 */
const ROOT = path.resolve(__dirname, "..");

/** 明确"未入库/查无此件"的路径家族（出现时必须带标注）。 */
const UNVERIFIABLE = ["docs/evidence-", "app-triage/", "lunora-image-size-rules.md", "measure-theme.py"];

/** 曾经被指向、但仓里并不存在的"假指针"（一个都不许再出现）。 */
const PHANTOM_POINTERS = ["shared/contextWindow.ts", "src/contextWindow.test.ts"];

function collect(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === "node_modules") continue;
      collect(full, out);
    } else if (/\.(tsx?|mjs|css)$/.test(name) && !/\.test\.tsx?$/.test(name)) {
      out.push(full);
    }
  }
  return out;
}

describe("保真依据可复核或如实标注（G34 / G35）", () => {
  const files = [
    ...collect(path.join(ROOT, "src")),
    ...collect(path.join(ROOT, "shared")),
    ...collect(path.join(ROOT, "engine")),
    ...collect(path.join(ROOT, "hosts")),
    ...collect(path.join(ROOT, "scripts")),
  ];

  it("引用「未入库」依据的每一行，都带 `无法复核` 的标注", () => {
    const offenders: string[] = [];
    for (const file of files) {
      const rel = path.relative(ROOT, file).split(path.sep).join("/");
      const lines = readFileSync(file, "utf8").split("\n");
      for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i]!;
        if (!UNVERIFIABLE.some((t) => line.includes(t))) continue;
        if (line.includes("无法复核")) continue;
        offenders.push(`${rel}:${i + 1}`);
      }
    }
    expect(
      offenders,
      [
          "这些行引用了**未入库、本机也找不到**的依据文件，却没写明「无法复核」 ——",
        "读的人会以为有据可查（审计 G34）。做法：在那一行补上标注，",
        "或把依据指向仓里真有的东西（测试/夹具/ADR）。",
        offenders.join("\n"),
      ].join("\n"),
    ).toEqual([]);
  });

  it("指向仓内文件的注释，那个文件必须真的存在（G35 的假指针一个都不许有）", () => {
    const offenders: string[] = [];
    for (const file of files) {
      const rel = path.relative(ROOT, file).split(path.sep).join("/");
      const text = readFileSync(file, "utf8");
      for (const pointer of PHANTOM_POINTERS) {
        if (text.includes(pointer)) offenders.push(`${rel} → ${pointer}`);
      }
    }
    expect(offenders, "这些注释指向的文件在仓里不存在（改指真实落点，或写明它已不存在）").toEqual([]);
  });
});
