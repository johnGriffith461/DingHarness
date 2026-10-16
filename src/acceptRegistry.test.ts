import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * 守卫：**验收脚本的"在册"对账**（2026-10-16，审计 G96）。
 *
 * ## 为什么这条必须存在
 *
 * `scripts/accept/DEFECT-PROTOCOL.md` 第 4/5 步写的是硬规矩：
 * 「不进批跑 = 没人跑」「没有回归用例的修复不算修完」。而仓里只有**一个方向**的对账 ——
 * `verify-acceptances.mjs` 查「登记了 → 文件在不在」（缺则记一笔红）；
 * 反过来「**文件在 → 没登记**」没有任何东西在查。
 *
 * 这正是本仓反复清的"静默少测比测试失败更危险"：脚本写着、看着像被测了，
 * 实际从没被任何一轮跑过。实测（2026-10-16）：`scripts/accept/` 有 99 个 `accept-*.mjs`，
 * `CASES` 只登记 71 个。
 *
 * ## 这条守的是什么
 *
 * 1. **两向对账**：每个 `accept-*.mjs` 要么在 `CASES`（批跑里），要么在 `NOT_IN_BATCH`
 *    （结构化名单，`kind` + `why` 必填）。两边都没有 → 红，并告诉写脚本的人该做什么。
 * 2. **名单不许烂**：`NOT_IN_BATCH` 的每个键都得对应一个真实文件（不能写着已经不存在的脚本）；
 *    `kind` 只能是那四种；`why` 不许空。
 * 3. **债要记账**：`kind: "debt"`（本该进批跑还没进）的条数被**棘轮**卡住 —— 只许少不许多。
 *    这解决了散文式借口的根本问题：借口可以随便写，账本不能随便长。
 *
 * ⚠️ 判据是**读那两个文件**（名单在 runner 里，是数据不是散文）。
 * 谁改 `NOT_IN_BATCH` 的写法导致这里解析不到，这条会红 —— 那是有意的：
 * 名单的格式本身就是这条门的一部分。
 */

const ROOT = path.resolve(__dirname, "..");
const RUNNER = path.join(ROOT, "scripts/verify-acceptances.mjs");
const SCRIPT_DIR = path.join(ROOT, "scripts/accept");

/** 允许的 kind（与 runner 里那段说明一致）。 */
const KINDS = ["needs-model", "needs-package", "debt", "retired", "fossil"];

/**
 * `debt` 的棘轮上限。
 *
 * ⚠️ 这个数字**只许往下调**。现在这 8 条的共同形状是"自己 spawn Electron（老一代写法）"，
 * 外加 2 条"早就该进批跑、纯粹是没排上"的。改造一条、把它跑通后登记进 `CASES`，
 * 就把这里的数字减一 —— 与 `structureGuard` 的行数上限、`themeRatchet` 的硬编码上限同一个套路。
 */
const MAX_DEBT = 5;

/**
 * `fossil`（化石：打 dev server / 硬编码本机路径，早与产品脱节）的棘轮上限。
 *
 * 这一类比 `debt` 更该消失：`debt` 是"该进批跑还没进"，`fossil` 是"已经不是这个产品的验收了"。
 * 处理办法二选一：按 `bootApp` 重写（那就变成 debt → CASES），或者删掉（git 留着历史）。
 */
const MAX_FOSSIL = 3;

/**
 * `retired`（墓碑）的上限。
 *
 * 退役是正当处置（界面拆了、判据被别处接住），但它**不能变成**"这条跑了太麻烦、标退役算了"的出口 ——
 * 所以同样给个数字：只许少不许多。`accept-providers` 2026-10-16 退役时是 3 条（另两条：`accept-p5-prompt`、`accept-theme`）。
 */
const MAX_RETIRED = 3;

function parseRegistry(): Record<string, { kind: string; why: string }> {
  const text = readFileSync(RUNNER, "utf8");
  const out: Record<string, { kind: string; why: string }> = {};
  const re = /^\s*"([^"]+\.mjs)":\s*\{\s*kind:\s*"([^"]+)",\s*why:\s*"([^"]*)"\s*\},?\s*$/gm;
  for (const m of text.matchAll(re)) {
    out[m[1]!] = { kind: m[2]!, why: m[3]! };
  }
  return out;
}

function parseCases(): string[] {
  const text = readFileSync(RUNNER, "utf8");
  const start = text.indexOf("const CASES = [");
  const end = text.indexOf("\n];", start);
  expect(start, "runner 里找不到 CASES").toBeGreaterThan(-1);
  /*
   * ⚠️ **先去掉注释**：CASES 里躺着几行被注释掉的旧登记（`// ["accept-writing.mjs", …]`）——
   * 那是改过名/退役过的历史痕迹，**本来就没在执行**（runner 是运行这份文件取 CASES 的，
   * 注释对它不存在）。不剥注释的话，这条守卫会来报"登记了但文件不在"，
   * 而那两行根本没跑过。守卫必须与 runner 看到同一份清单。
   */
  const body = text.slice(start, end);
  const noBlock = body.replace(/\/\*[\s\S]*?\*\//g, "");
  const noComments = noBlock
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n");
  return [...noComments.matchAll(/\["([^"]+\.mjs)"/g)].map((m) => m[1]!);
}

describe("验收脚本的「在册」对账（DEFECT-PROTOCOL 第 4/5 步的机械化）", () => {
  const onDisk = readdirSync(SCRIPT_DIR).filter((f) => f.startsWith("accept-") && f.endsWith(".mjs"));
  const registered = new Set(parseCases());
  const registry = parseRegistry();
  const inRegistry = new Set(Object.keys(registry));

  it("① 盘上每个 accept-*.mjs 都有归属：在批跑里，或在结构化名单里", () => {
    const orphans = onDisk.filter((f) => !registered.has(f) && !inRegistry.has(f));
    expect(
      orphans,
      [
        "这些脚本既不在批跑 CASES 里、也不在 NOT_IN_BATCH 名单里 —— 也就是**没有任何一轮会跑它**：",
        orphans.map((f) => `  scripts/accept/${f}`).join("\n"),
        "要么把它登记进 verify-acceptances.mjs 的 CASES（先本地跑通），要么在 NOT_IN_BATCH 里写清 kind 与 why。",
      ].join("\n"),
    ).toEqual([]);
  });

  it("② 名单不许烂：键都要对应真实文件，kind 合法，why 不许空", () => {
    const files = new Set(onDisk);
    const stale = [...inRegistry].filter((f) => !files.has(f));
    expect(stale, `NOT_IN_BATCH 里列着已经不存在的脚本（删了脚本要顺手删名单）：${stale.join(" / ")}`).toEqual([]);
    for (const [name, entry] of Object.entries(registry)) {
      expect(KINDS, `${name} 的 kind 是 "${entry.kind}"，不在允许的四种里（${KINDS.join(" / ")}）`).toContain(entry.kind);
      expect(entry.why.trim().length, `${name} 的 why 是空的 —— 名单存在的意义就是"为什么"`).toBeGreaterThan(8);
    }
  });

  it("③ 批跑登记项的文件都在（这一半 runner 自己也在查，这里再钉一次）", () => {
    const files = new Set(onDisk);
    const missing = [...registered].filter((f) => !files.has(f));
    expect(missing, `CASES 里登记了但文件不在：${missing.join(" / ")}`).toEqual([]);
  });

  it(`④ 「本该进批跑、还没进」的明账只许少不许多（现在 ${MAX_DEBT} 条上限）`, () => {
    /*
     * ⚠️ 这一条是给"借口"上的棘轮。散文式借口的根本问题是它能随便长，
     * 而这里 `debt` 的条数是**数字**，多一条就红。
     * 处理一条的办法只有两个：改造它（改完登记进 CASES）、或把 kind 改成有据可依的那三种。
     */
    const debt = Object.entries(registry)
      .filter(([, e]) => e.kind === "debt")
      .map(([name, e]) => `${name}：${e.why}`);
    expect(
      debt.length,
      ["这批「本该进批跑却还没进」的脚本比上限多 —— 明账不许自己长大：", ...debt.map((d) => `  ${d}`)].join("\n"),
    ).toBeLessThanOrEqual(MAX_DEBT);
    expect(debt.length, "棘轮只许往下调：债少了就把 MAX_DEBT 也调小").toBe(MAX_DEBT);
  });

  it(`⑤ 退役（墓碑）也只许少不许多（现在 ${MAX_RETIRED} 条上限）`, () => {
    const retired = Object.entries(registry).filter(([, e]) => e.kind === "retired");
    const retiredList = retired.map(([n, e]) => `  ${n}：${e.why}`).join("\n");
    expect(
      retired.length,
      ["退役的比上限多（退役不是删不掉的出口）：", retiredList].join("\n"),
    ).toBeLessThanOrEqual(MAX_RETIRED);
    expect(retired.length, "棘轮只许往下调：墓碑少了就把 MAX_RETIRED 也调小").toBe(MAX_RETIRED);
  });

  it(`⑥ 化石也只许少不许多（现在 ${MAX_FOSSIL} 条上限）`, () => {
    const fossils = Object.entries(registry)
      .filter(([, e]) => e.kind === "fossil")
      .map(([name, e]) => `${name}：${e.why}`);
    expect(
      fossils.length,
      ["化石比上限多（这些早就不是本产品的验收了）：", ...fossils.map((f) => `  ${f}`)].join("\n"),
    ).toBeLessThanOrEqual(MAX_FOSSIL);
    expect(fossils.length, "棘轮只许往下调：化石少了就把 MAX_FOSSIL 也调小").toBe(MAX_FOSSIL);
  });
});
