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
const MAX_DEBT = 0;

/**
 * `fossil`（化石：打 dev server / 硬编码本机路径，早与产品脱节）的棘轮上限。
 *
 * 这一类比 `debt` 更该消失：`debt` 是"该进批跑还没进"，`fossil` 是"已经不是这个产品的验收了"。
 * 处理办法二选一：按 `bootApp` 重写（那就变成 debt → CASES），或者删掉（git 留着历史）。
 */
const MAX_FOSSIL = 0;

/**
 * `retired`（墓碑）的上限。
 *
 * 退役是正当处置（界面拆了、判据被别处接住），但它**不能变成**「这条跑了太麻烦、标退役算了」的出口 ——
 * 所以同样给个数字：只许少不许多。
 *
 * ⚠️ 2026-10-16 从 3 降到 **0**（A22 收口）：三条墓碑各归其位 ——
 *   · `accept-providers` **按现界面重写并收进批跑**（原来它覆盖的「真探测 → 界面标出已验证」
 *     是墓碑自己都承认"没有替代品"的那半个，所以重写比删掉更对）；
 *   · `accept-p5-prompt` 与 `accept-theme` **删掉**（判据分别由 `src/canvas/markers.test.ts`
 *     与 `accept-accountmenu.mjs` 接住，git 里留着历史）。
 */
const MAX_RETIRED = 0;

/**
 * `scripts/accept/` 里**裸写业务数据**的夹具清单（不走 C1 信封）—— 只许少不许多。
 *
 * ## 这条守的是什么（2026-10-16，审计 G130）
 *
 * 落盘实体的**正典格式**是 C1 的信封 `{ __schema: 1, data: … }`（`electron/ipc/jsonStore.ts`），
 * 而同一个目录里两种写法同时存在：`accept-mcp` / `accept-workspace` 写信封，
 * 另外一批夹具**裸写**（直接写业务对象或数组），靠 jsonStore 的「兼容旧格式」读兜着。
 *
 * 风险是**双向**的：
 *   · 兼容读哪天收紧，这些夹具会**静默失效**（应用读到空库，脚本红得莫名其妙 ——
 *     与 §56 那次"存储换 SQLite 之后脚本还在读 jsonl"同一个形状）；
 *   · 反过来，它们是「裸格式仍然被支持」这条承诺的**唯一固化点**，而现在没人知道有几条。
 *
 * 所以：**裸写要登记**，新增一条当场红；改造完（改成信封写法）也要把名字划掉 ——
 * 两个方向都查，与 `NOT_IN_BATCH` 那张名单同一个口径。
 *
 * ⚠️ 如实记两条边界：
 *   ① 检测是**扫源码形状**的（`writeFileSync(path.join(DATA, "x.json"), JSON.stringify(` 之后
 *      紧跟的是不是 `{ __schema`）—— 把对象先放进变量再 stringify 的那种**看不出来**，
 *      会算成"裸写"（保守方向：宁可多报，也不放过一条不登记的）；
 *   ② 画布快照（`canvas/*.json`）**不算**业务实体：它没有信封，那个 `version` 是画布文档
 *      自己的格式版本（见 `harness.mjs` 的 `readStoreFile` 那段说明），不在这一条射程里。
 */
const BARE_FIXTURES = [
  /*
   * T-01（2026-10-19）：这条真 provider 验收要预置 `models.json`（模型能力表）——
   * 它的磁盘格式**本来就不是** C1 信封，而是 `{version, rules}`（见
   * `engine/adapters/modelConfigStore.ts` 的 `writeModelConfig`）。所以扫到"裸写"是对的，
   * 这里明确登记：不是漏了信封，是那个文件有自己的版本字段。
   * settings.json 用的是标准信封（`{__schema:1,data}`）。
   */
  "accept-approvals-audit-real.mjs",
  "accept-approve.mjs",
  "accept-artifacts.mjs",
  "accept-createdoc.mjs",
  "accept-memoryinject.mjs",
  "accept-pinneddead.mjs",
  "accept-proto.mjs",
  "accept-restore.mjs",
  "accept-schedbad.mjs",
  "accept-scheddraft.mjs",
  "accept-taskcenter.mjs",
  "accept-threads.mjs",
];

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

  it(`④ 「本该进批跑、还没进」的明账必须清零（现在 ${MAX_DEBT}）—— 清单外的脚本要并进来`, () => {
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

  it(`⑥ 化石必须清零（现在 ${MAX_FOSSIL}）—— 不能跑的产品化石不留`, () => {
    const fossils = Object.entries(registry)
      .filter(([, e]) => e.kind === "fossil")
      .map(([name, e]) => `${name}：${e.why}`);
    expect(
      fossils.length,
      ["化石比上限多（这些早就不是本产品的验收了）：", ...fossils.map((f) => `  ${f}`)].join("\n"),
    ).toBeLessThanOrEqual(MAX_FOSSIL);
    expect(fossils.length, "棘轮只许往下调：化石少了就把 MAX_FOSSIL 也调小").toBe(MAX_FOSSIL);
  });

  it("⑦ 裸写业务 JSON 的夹具必须登记（G130：只许少不许多）", () => {
    /*
     * 扫的是**形状**：`writeFileSync(path.join(DATA, "x.json"), JSON.stringify(` 之后
     * 紧跟的是不是 `{ __schema`。看不出来的（先放变量再 stringify）算成裸写 ——
     * 保守方向：宁可多报一条让人来登记，也不放过一条悄悄固化裸格式的。
     */
    const found: string[] = [];
    for (const file of onDisk) {
      const text = readFileSync(path.join(SCRIPT_DIR, file), "utf8");
      const re =
        /writeFileSync\(\s*path\.join\(\s*DATA\s*,\s*"([^"]+\.json)"\s*\)\s*,\s*JSON\.stringify\(\s*([\s\S]{0,60})/g;
      for (const m of text.matchAll(re)) {
        const head = (m[2] ?? "").trimStart();
        if (!/^\{\s*__schema/.test(head)) found.push(file);
      }
    }
    const bare = [...new Set(found)].sort();
    const declared = [...BARE_FIXTURES].sort();

    const extra = bare.filter((f) => !declared.includes(f));
    expect(
      extra,
      [
        "这些夹具**裸写**业务数据（没走 C1 信封），而且没登记：",
        extra.map((f) => `  scripts/accept/${f}`).join("\n"),
        "两条路二选一：① 改成信封写法 `JSON.stringify({ __schema: 1, data: … })`（与 accept-mcp 一致）；",
        "② 明确登记进 src/acceptRegistry.test.ts 的 BARE_FIXTURES 并写清理由。",
        "为什么要有这一条：兼容读一旦收紧，这些夹具会静默失效；而它们又是「裸格式仍被支持」的唯一固化点。",
      ].join("\n"),
    ).toEqual([]);

    const gone = declared.filter((f) => !bare.includes(f));
    expect(
      gone,
      [
        "这些登记在 BARE_FIXTURES 里，但现在**已经不是裸写**了（改造成信封 / 删了夹具）：",
        gone.map((f) => `  scripts/accept/${f}`).join("\n"),
        "把名字从 BARE_FIXTURES 里划掉 —— 这份名单的条数与现实必须一致（只许少不许多）。",
      ].join("\n"),
    ).toEqual([]);
  });
});
