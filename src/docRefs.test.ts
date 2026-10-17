import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * 守卫：**注释指向的文件，要么在仓里，要么写明"没入库"**（2026-10-16，审计 P94）。
 *
 * ## 为什么这条要有（也是主人拍板的 D9）
 *
 * 审计数出来：源码里指向 `docs/**` 的引用有 59 处、55 个文件，而 `docs/` **既不入库也不存在**
 * （`.gitignore` 排除了它）—— 于是"为什么不这么做"的决策链**断在注释里**：
 * 照着注释去找依据的人，只会扑空，而且**扑空这件事本身没有任何提示**。
 * CHANGELOG 里那句「每一处推理写在代码注释里」也因此成了不实陈述（已改）。
 *
 * ## 判据
 *
 * 源码/脚本/根文档里出现形如 `docs/<路径>` 的引用时：
 *   · 那个路径**真的在仓里** → 通过；
 *   · 不在 → **同一个文件里**必须有一句"该依据未入库…无法复核"的标注（说明它去哪了、能不能复核）。
 *
 * 刻意**不**要求"删掉这些引用"：引用本身是有信息量的（"当初为什么这么定"），
 * 要治的是"指向一个读者永远找不到的东西却不说"。
 *
 * ## 边界（如实记）
 *
 * 只扫 `docs/` 这一族（P94 数的就是它）。`engine/eval/samples/` 那些**在仓里**，
 * 引用它们本来就点得开（ADR 不入库，只留本地 `docs/ADR/`）。扫的是文本（含字符串字面量里的说明文字），所以下面有一张
 * **极小的**豁免名单，每条都得写清为什么它不是"断链的引用"。
 */

const ROOT = path.resolve(__dirname, "..");
const SCAN_DIRS = ["src", "engine", "hosts", "electron", "shared", "scripts"];
const EXT = [".ts", ".tsx", ".mjs"];
const ROOT_DOCS = ["README.md", "CHANGELOG.md", "SAFETY.md", "PLUGIN.md", "CONTRIBUTING.md"];

/**
 * 豁免（**只许更短**）：
 *   · `scripts/perf-budget.ts` —— 它那句 `docs/` 是**说明为什么不用 docs/**（"基线落在
 *     engine/eval 而不是 docs/：docs/ 被 .gitignore 排除了"），本身就是在讲这件事，不是断链引用。
 */
const EXEMPT = new Set(["scripts/perf-budget.ts"]);

/** 已经写明"没入库"的标记（P94 加的；措辞统一在 `.tmp` 那批里落成）。 */
const MARKER = "未入库";

function files(): string[] {
  const out: string[] = [];
  for (const dir of SCAN_DIRS) {
    const walk = (d: string) => {
      for (const name of readdirSync(d)) {
        const full = path.join(d, name);
        if (statSync(full).isDirectory()) {
          if (name === "node_modules") continue;
          walk(full);
        } else if (EXT.some((e) => name.endsWith(e))) out.push(full);
      }
    };
    walk(path.join(ROOT, dir));
  }
  for (const d of ROOT_DOCS) {
    const full = path.join(ROOT, d);
    try {
      if (statSync(full).isFile()) out.push(full);
    } catch {
      /* 没有就没有 */
    }
  }
  return out;
}

describe("注释里的 docs/ 引用（P94 / D9）", () => {
  it("⭐ 指向 `docs/**` 的引用：要么文件真在，要么写明「未入库、无法复核」", () => {
    const offenders: string[] = [];
    for (const file of files()) {
      const rel = path.relative(ROOT, file).split(path.sep).join("/");
      if (EXEMPT.has(rel)) continue;
      const text = readFileSync(file, "utf8");
      for (const m of text.matchAll(/docs\/[A-Za-z0-9._\u4e00-\u9fa5-]+/g)) {
        const target = m[0];
        const exists = (() => {
          try {
            return statSync(path.join(ROOT, target)).isFile();
          } catch {
            return false;
          }
        })();
        if (exists) continue;
        if (text.includes(MARKER)) continue;
        const line = text.slice(0, m.index).split("\n").length;
        offenders.push(`${rel}:${line} → ${target}`);
      }
    }
    expect(
      offenders,
      [
        "这些注释指向的文件既不在仓里、也没写明「没入库」—— 读者照着找只会扑空，而且扑空时没有任何提示：",
        ...offenders,
        "",
        "处理办法二选一：把依据挪进仓（ADR/ 或 engine/eval/ 那些），或在同一文件里加一句",
        "「该依据未入库、本机也找不到 —— 决策链断在这里，无法复核；以本文件里的断言与实现为准」。",
      ].join("\n"),
    ).toEqual([]);
  });

  it("⭐ 反向：既然写明了没入库，就不许再指着它当依据（标注要成对出现）", () => {
    /*
     * 这一条防的是"标了却照旧当依据用"：文件里同时有"未入库"与"原本记在 docs/xxx.md 第 N 节"这种
     * **指令式**引用（"见/详见/参见 … docs/"）时，说明它还在把人往那儿指。
     */
    const offenders: string[] = [];
    for (const file of files()) {
      const rel = path.relative(ROOT, file).split(path.sep).join("/");
      if (EXEMPT.has(rel)) continue;
      const text = readFileSync(file, "utf8");
      if (!text.includes(MARKER)) continue;
      const lines = text.split("\n");
      for (const [i, line] of lines.entries()) {
        if (!/(见|详见|参见|照着|按)\s*`?docs\//.test(line)) continue;  // 指路式引用
        offenders.push(`${rel}:${i + 1} → ${line.trim().slice(0, 80)}`);
      }
    }
    expect(offenders, ["已标注「未入库」的地方还在「原本记在 docs/…」地指路：", ...offenders].join("\n")).toEqual([]);
  });
});
