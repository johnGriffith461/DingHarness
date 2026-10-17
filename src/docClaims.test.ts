import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { HOOK_NAMES, PLUGIN_PERMISSIONS } from "@engine/runtime/plugins";

/**
 * 守卫：**自述与实现不符**（2026-10-16，审计 D9 / 第 6 单那一族）。
 *
 * ## 这条补的是哪一格
 *
 * 这一轮反复清的一类缺陷是"注释/文档里写着的话，与代码里的事实不符"：
 * 指向一个不存在的文件（P94/P207）、点名一个不存在的判据（P103）、
 * 给一条**不存在**的命令（P206：文档写 `ding plugins uninstall`，实现叫 `remove`）、
 * 权限/钩子的词表与代码里的常量对不上（P204）。它们的共同形状是：
 * **读者照着去找，会扑空，而扑空这件事本身没有任何提示。**
 *
 * 已有的两条守卫各管一段：`docRefs.test.ts` 只管 `docs/**`（P94）、
 * `ipcContract.test.ts` 只管 IPC 通道那一对。**"点名了判据"与"点名了命令"
 * 这两半没有人管** —— 这条补上。
 *
 * ## 七条判据（都是机械可判定的）
 *
 * | # | 判据 | 红的时候你会看到 |
 * |---|---|---|
 * | ① | 注释/文档里出现**入库路径形态**的引用（`src/…` `shared/…` `.github/…` …）时，那个路径必须真的在仓里，**或者**同一行写明它已不在（"原来/曾是/未入库/无法复核/不存在"） | "照着这个路径找不到东西" |
 * | ② | 本地目录 `.verify/…` 的**指路式**引用（"见/参照/依据/证据"）必须写明它是本地记录（本地/探针/一次性/实拍/实测…） | "把本地截图当成入库依据在指路" |
 * | ③ | 点名的**判据**（`xxx.test.ts` / `accept-xxx.mjs`）必须真的在仓里 | "它说这条有测试盯着，而那个测试不存在" |
 * | ④ | 判据要**真的在判**：每个测试文件里至少得有一处断言 | "点名了一个空壳测试来交差" |
 * | ⑤ | 注释里的**完成态断言**（"已接入/已实现/已修复/只读不动"…）必须在同一段注释里点名判据，或落进带 why 的豁免名单 | "这句『已接』没有任何东西盯着" |
 * | ⑥ | **插件词表两向对账**：`PLUGIN.md` 的权限/钩子/清单字段必须与 `engine/runtime/plugins.ts` 的常量一一对上 | "文档教的权限名代码里没有（或反过来）" |
 * | ⑦ | **CLI 命令点名必须有人接**：文档/注释里写的 `ding <命令>` 与 `ding plugins <子命令>` 必须在 `hosts/cli/ding.ts` 的派发里真的存在；用法串与派发集合必须相等 | "文档让用户跑的命令不存在"（P206 就是这个） |
 *
 * ## 边界（如实记，宁可窄而真）
 *
 * - **`CHANGELOG.md` 与 `SAFETY.md` 不在扫面里**：前者是**历史记录**（它逐条描述当时的
 *   探针与旧文件名，"引用已经不存在的脚本"正是它的内容），后者不在本轮独占范围。
 *   `docs/ADR/` **不在**扫面里（2026-10-17 用户裁定 ADR 不入库，只留本地）。
 * - **路径按"整路径优先、再按文件名"解析**：注释里写的是短名（`cost.test.ts`）时按
 *   仓内同名文件认。宽一档是为了压住误报 —— 代价是"写错目录但同名"放行，如实记。
 * - **⑤ 只管完成态断言**（`已接入/接上/实现/修复/覆盖/生效/落地/补齐/钉住/只读不动`）。
 *   更宽的那一族（"不会动/不许改"）在中文里大量是**讲道理**（"写两份的话改文案不会改到判定"），
 *   按裸词扫会淹在误报里 —— 所以不收，如实记这条门禁管不到它。
 * - 豁免名单都**卡总数**（学 `acceptRegistry.test.ts` 的棘轮）：只许少不许多。
 */

const ROOT = path.resolve(__dirname, "..");

/** 扫面（`.github/` 在里 —— 那里的注释同样会把人指丢）。 */
const SCAN_DIRS = ["src", "engine", "hosts", "electron", "shared", "scripts", "sandbox", ".github", "plugin-samples"];

/** 根文档（`CHANGELOG.md`/`SAFETY.md` 有意不收，见文件头边界）。 */
const ROOT_DOCS = ["README.md", "PLUGIN.md", "CONTRIBUTING.md", "CODE_OF_CONDUCT.md"];

const EXT = [".ts", ".tsx", ".mjs", ".js", ".rs", ".md", ".yml", ".yaml"];

/** 入库的顶层目录（写这些前缀 = "仓里有一份"）。 */
const REPO_PREFIX = ["src", "shared", "engine", "hosts", "electron", "scripts", "sandbox", ".github", "plugin-samples"];

/** 同一行里"它已经不在了"的说法（①用）。 */
const GONE_MARK = /不存在|没有这个文件|压根没有|找不到|未入库|无法复核|原来|原本|曾经|已删|已退役|已拆|已移走|已搬|旧名|改名前|化石|待删|不再|写了但|从来没有/;

/** ③ 的豁免（**只许更短**）：点名的判据不存在，而那几处不在本轮独占范围。 */
const ABSENT_JUDGE_FILES = new Map<string, string>([
  [
    "electron/ipc/driveStore.ts",
    "它在讲 A1（那份重复常量已删）时点了 `src/workbench/driveFiles.test.ts` 与 `shared/driveFiles.ts`，而这两个文件随云盘页拆掉一起没了 —— 真事实现在是「从 `shared/drive.ts` 导入」。electron/** 不在本轮范围，落名单卡总数；下次有人改这里，把点名改成 `src/workbench/readTool.test.ts` 或 `shared/drive.ts` 即可销账。",
  ],
  [
    "engine/core/policy.ts",
    "注释写「`permissions.test.ts` 盯着这件事」，仓里没有这个文件（真的那份是 `engine/core/policy.test.ts`，它确实验了逐条声明）。engine/** 不在本轮范围，落名单卡总数。",
  ],
  [
    "scripts/accept/ATTACH-ONLY.md",
    "这份清单本身已经**过期**：§一 列的三条（`accept-final` / `accept-image` / `accept-p2`）与 §二 的 `accept-p3` 都已随「化石清理」删掉（盘上 96 条脚本里没有它们）。真缺陷，但 scripts/** 不在本轮范围 —— 落名单卡总数，等它的主人把表里那几行标成「已删」就能销账。",
  ],
  [
    "scripts/verify-acceptances.mjs",
    "里面点名已删脚本的地方两类：一类是形如 `// [accept-final.mjs, …]` 的**被注释掉的旧登记**（`acceptRegistry.test.ts` 已写明它是历史痕迹、runner 根本看不见），一类是「这四条试过、暂时不在批跑里」那段散文（`accept-p5-ref.mjs` 已删）。scripts/** 不在本轮范围，落名单卡总数。",
  ],
]);
const MAX_ABSENT_JUDGE = 4;

/** ② 的豁免（**只许更短**）。 */
const LOCAL_POINTER_FILES = new Map<string, string>([
  [
    "src/workbench/TitleBar.tsx",
    "「根因与证据：`electron/ipc/windowControls.ts`、`.verify/m0/repro-cloud-topright.png`」—— 那句里的 `.verify/` 是**本地实拍截图**，但同行的说法是「证据」而不是「本地/实拍」，读者可能以为它入库。src/workbench/** 不在本轮范围，落名单卡总数。",
  ],
]);
const MAX_LOCAL_POINTER = 1;

/** ⑤ 的豁免（**只许更短**）。 */
const CLAIM_EXEMPT_FILES = new Map<string, string>([
  [
    "scripts/verify-acceptances.mjs",
    "「已改成相对仓库根的路径」讲的是**批跑装置自己的历史改动**（脚本从绝对路径改成相对路径），不是产品能力断言；它有没有生效由 `src/acceptRegistry.test.ts` 与批跑本身盯着，但那两条盯的不是这句话。scripts/** 不在本轮范围，落名单卡总数。",
  ],
  [
    "scripts/accept/DEFECT-PROTOCOL.md",
    "§三 那句「自动化已覆盖前两条」讲的是**走查装置**（真的由 `src/windowChrome.test.ts ①/②` 盯着，但那一段没点名它）；这份文件是流程说明，本身属 scripts/** 不在本轮范围。落名单卡总数。",
  ],
]);
const MAX_CLAIM_EXEMPT = 2;

/** ⑦ 里"它本来就在讲一个错的命令"的说法（举例打错的命令、或说明某条命令不存在）。 */
const WRONG_CMD_MARK = /打错|打成|拼错|拼写|写错|不认识的|未知|例如|比如|不存在|没有这个|没有它|实现里没有/;

/**
 * ⑤ 触发的完成态断言。
 *
 * ⚠️ `已接` 后面排掉 `接管/接上口` 之类同形词（这个仓里「已经接管」是讲互斥回调的）。
 */
const CLAIM_RE = /已(?:接(?![管收口])|接入|接上|接通|接进|实现|修复|覆盖|生效|落地|补齐|钉住)|只读不动/;

/**
 * ⑤ 认的"判据"：**点名到具体一个**（测试文件 / 验收脚本 / 守卫 / 门禁）。
 *
 * ⚠️ 故意**不认**裸的「判据」二字：这个仓里"以本文件里的断言与判据为准"这类话到处都是，
 * 认它等于让整段注释随便一写就过关（第一版就是这样，变异实证时发现加一句「已接入」
 * 仍能溜过去）。宁可窄一点 —— 窄而真。
 */
const JUDGE_MARK = /\.test\.(ts|tsx)|accept-[a-z0-9-]+\.mjs|守卫|门禁/;

/** 注释行（`*` / `//` / 块首 / `#`）。 */
const COMMENT_LINE = /^\s*(\*|\/\/|\/\*|#)/;

/** ① 认的"文件"后缀（把 `xxx.yyy` 这种符号从路径里排掉）。 */
const SOURCE_EXT = new Set(["ts", "tsx", "mjs", "js", "rs", "md", "yml", "yaml", "json", "css", "html"]);

/**
 * 取 `index` 那一行**连同它所属的注释块**（上下相邻的注释行）。
 *
 * ① 的"已不在"说明允许写在同一段注释里（不要求死钉在同一行）：
 * 注释是连在一起读的，读者看到「原来在 X」这一句就算拿到了提示。
 */
function blockAround(rows: string[], index: number): string {
  let out = rows[index] ?? "";
  for (let j = index - 1; j >= 0 && COMMENT_LINE.test(rows[j] ?? ""); j -= 1) out += `\n${rows[j]}`;
  for (let j = index + 1; j < rows.length && COMMENT_LINE.test(rows[j] ?? ""); j += 1) out += `\n${rows[j]}`;
  return out;
}

/**
 * ① 的豁免（**只许更短**）：真的指向一个已经搬走的文件，而那几处在别的区域。
 *
 * 前五条是**同一个根因**：工具权限的声明从 `shared/permissions.ts` 搬进了
 * `engine/core/policy.ts`（注释还指着老地方）。其余几条同理（`shared/sessionLog.ts`
 * 搬进 `engine/`、`shared/driveOps.ts` 随云盘页拆掉、`aiProviders.ts` 拆掉）。
 * 这些文件不在本轮独占范围 —— 落名单卡总数；谁改到哪条，把路径改成真的那份就能销账。
 */
const PHANTOM_PATH_FILES = new Map<string, string>([
  ["shared/agentTools.ts", "两处注释把工具权限声明指成 `shared/permissions.ts`（已搬进 `engine/core/policy.ts`）。本文件在本轮范围内，但**改这两处要同时改 gate 那边的说法**，留给下一轮一起做；先卡总数。"],
  ["electron/ipc/mcpStore.ts", "同上（`shared/permissions.ts` 已搬走）。electron/** 不在本轮范围。"],
  ["engine/runtime/loop.ts", "注释把 `ProjectableEvent` 指成 `shared/sessionLog.ts`（已搬进 engine 那侧）。engine/** 不在本轮范围。"],
  ["engine/runtime/tools/execTool.ts", "同 `shared/permissions.ts` 那一条。engine/** 不在本轮范围。"],
  ["engine/runtime/tools/searchTool.ts", "同 `shared/permissions.ts` 那一条。engine/** 不在本轮范围。"],
  ["scripts/accept/accept-material.mjs", "同 `shared/permissions.ts` 那一条。scripts/** 不在本轮范围。"],
  ["scripts/accept/accept-providers.mjs", "注释还指着已删的 `src/chat/ChatSidebar.tsx`（聊天子系统整块移除了）。scripts/** 不在本轮范围。"],
  ["src/workbench/compaction.ts", "注释说「`electron/ipc/aiProviders.ts` 里没有这个字段」，而那个文件已经拆掉了 —— 真事实是那几个模型通道走的另一条路。src/workbench/** 不在本轮范围。"],
]);
const MAX_PHANTOM_PATH_FILES = 8;

/** 递归列文件（跳过产物目录与测试夹具之外的重目录）。 */
function listFiles(): string[] {
  const skip = new Set([
    "node_modules",
    ".git",
    "release",
    "dist",
    "build",
    "dist-bin",
    "dist-cli",
    "dist-electron",
    "data",
    ".verify",
  ]);
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const full = path.join(dir, name);
      if (statSync(full).isDirectory()) {
        if (skip.has(name)) continue;
        walk(full);
      } else if (EXT.some((e) => name.endsWith(e))) out.push(full);
    }
  };
  for (const dir of SCAN_DIRS) {
    const full = path.join(ROOT, dir);
    if (existsSync(full)) walk(full);
  }
  for (const doc of ROOT_DOCS) {
    const full = path.join(ROOT, doc);
    if (existsSync(full)) out.push(full);
  }
  return out;
}

const rel = (file: string) => path.relative(ROOT, file).split(path.sep).join("/");

/** 仓里所有文件的**文件名**集合（③ 用：短名也算指得到）。 */
function basenames(): Set<string> {
  const skip = new Set(["node_modules", ".git", "release", "dist", "build", "dist-bin", "dist-cli", "dist-electron"]);
  const out = new Set<string>();
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const full = path.join(dir, name);
      if (statSync(full).isDirectory()) {
        if (skip.has(name)) continue;
        walk(full);
      } else out.add(name);
    }
  };
  walk(ROOT);
  return out;
}

/** 行号（1 起）取自 `index` 之前的字符数。 */
const lineAt = (text: string, index: number) => text.slice(0, index).split("\n").length;

describe("自述必须有判据 / 点名必须找得到（D9）", () => {
  const files = listFiles();
  const names = basenames();

  it("① 入库路径形态的引用：要么真在，要么同一行写明它不在", () => {
    const offenders: string[] = [];
    /*
     * ⚠️ 这层括号**必须**把整条前缀 alternation 包住：写成 `(src|shared/…规则)` 的话，
     * 后缀只绑在最后一个分支上（第一版就栽在这里 —— 全仓只查了 `plugin-samples/` 一个前缀，
     * 一条都扫不出来，"绿"是假的）。
     */
    const prefixes = REPO_PREFIX.map((p) => p.replace(".", String.fromCharCode(92) + ".")).join("|");
    const re = new RegExp(`(?:^|[^A-Za-z0-9_./-])((?:${prefixes})/[A-Za-z0-9_./-]+[.][A-Za-z0-9]+)`, "g");
    for (const file of files) {
      const relPath = rel(file);
      /* 测试文件整份跳过：那里的路径常常是**夹具**（`src/a.ts` 这种故意编的输入）
         或"这批假指针一个都不许再出现"的名单本身，而不是把读者往哪儿指。 */
      if (/\.test\.(ts|tsx|mjs)$/.test(relPath)) continue;
      if (PHANTOM_PATH_FILES.has(relPath)) continue;
      const text = readFileSync(file, "utf8");
      const rows = text.split("\n");
      for (const m of text.matchAll(re)) {
        const target = m[1]!;
        if (target.includes("...") || target.includes("${")) continue; // 模板/省略号，不是具体路径
        const ext = target.slice(target.lastIndexOf(".") + 1);
        if (!SOURCE_EXT.has(ext)) continue; // `agentTools.describeToolResult` 这种"符号里带点"不是路径
        if (existsSync(path.join(ROOT, target))) continue;
        const line = rows[lineAt(text, m.index!) - 1] ?? "";
        if (!COMMENT_LINE.test(line)) continue; // 只治"注释/文档在指路"，代码里的字符串不算
        if (/形如|例如|比如/.test(line)) continue; // 行里写明是格式示例的，不是在指路
        if (GONE_MARK.test(blockAround(rows, lineAt(text, m.index!) - 1))) continue;
        offenders.push(`${relPath}:${lineAt(text, m.index!)} → ${target}（附近没说它已不在）`);
      }
    }
    expect(
      offenders,
      [
        "这些引用是**入库路径的形状**，但仓里没有它 —— 照着找的人只会扑空（审计 P94 那一族，位置不只是 docs/）：",
        ...offenders,
        "",
        "两种处理：改成真路径，或在同一段注释里写明「原来在 …（后来搬走了）」这类话（P94 的口径）。",
      ].join("\n"),
    ).toEqual([]);
  });

  it("② `.verify/` 的指路式引用必须写明它是本地记录", () => {
    const localMark = /本地|探针|一次性|无法复核|不存在|未入库|不进库|gitignore|实拍|实测|截图|原来|曾经|已删/;
    const offenders: string[] = [];
    for (const file of files) {
      const relPath = rel(file);
      if (LOCAL_POINTER_FILES.has(relPath)) continue;
      const rows = readFileSync(file, "utf8").split("\n");
      for (const [i, line] of rows.entries()) {
        if (!COMMENT_LINE.test(line)) continue;
        if (!/见|详见|参见|参照|依据|证据/.test(line)) continue;
        if (!/\.verify\//.test(line)) continue;
        if (localMark.test(line)) continue;
        offenders.push(`${relPath}:${i + 1} → ${line.trim().slice(0, 90)}`);
      }
    }
    expect(
      offenders,
      [
        "这些注释**把 `.verify/` 当成依据在指路**，却没说明那是本地记录（`.verify/` 被 gitignore，只在这台机器上有）：",
        ...offenders,
        "",
        "补一句「（本地探针/实拍，未入库）」即可 —— 与 `docRefs` 那条同一个口径。",
      ].join("\n"),
    ).toEqual([]);
  });

  it("③ 点名的判据（测试 / 验收脚本）必须真的在仓里", () => {
    const offenders: string[] = [];
    for (const file of files) {
      const relPath = rel(file);
      if (/\.test\.(ts|tsx|mjs)$/.test(relPath)) continue; // 测试文件之间互相点名不在这条的射程
      if (ABSENT_JUDGE_FILES.has(relPath)) continue;
      const text = readFileSync(file, "utf8");
      const rows = text.split("\n");
      for (const m of text.matchAll(/([A-Za-z0-9_./-]+[.]test[.](?:ts|tsx|rs))/g)) {
        const target = m[1]!;
        if (existsSync(path.join(ROOT, target))) continue;
        if (names.has(path.basename(target))) continue; // 短名：仓里有同名文件就算找得到
        /* 同一行写明"它已经不在了"（例如「原来它叫 `accept-writing.mjs`」）就不算假点名 */
        if (GONE_MARK.test(rows[lineAt(text, m.index!) - 1] ?? "")) continue;
        offenders.push(`${relPath}:${lineAt(text, m.index!)} → ${target}`);
      }
      for (const m of text.matchAll(/(accept-[a-z0-9-]+[.]mjs)/g)) {
        if (existsSync(path.join(ROOT, "scripts/accept", m[1]!))) continue;
        if (GONE_MARK.test(rows[lineAt(text, m.index!) - 1] ?? "")) continue;
        offenders.push(`${relPath}:${lineAt(text, m.index!)} → scripts/accept/${m[1]}`);
      }
    }
    expect(
      offenders,
      [
        "这些地方**点名了一个判据，而那个判据不存在** —— 读者会以为这件事有人在盯着（审计 P103 就是这个形状）：",
        ...offenders,
        "",
        "改成真的那份（这份仓里守卫大多在 `src/*.test.ts`、`shared/*.test.ts`、`engine/**/*.test.ts`），或写明它已经不在了。",
      ].join("\n"),
    ).toEqual([]);
  });

  it("④ 判据要真的在判：每个测试文件里至少有一处断言，且不许只剩恒真断言", () => {
    /*
     * ⚠️ 2026-10-16（落地当轮补的）：这一条原来只查"文件里出现过 `expect(`" ——
     * 而 `expect(true).toBe(true)` 也算出现过。仓里**正好有这么一条**
     * （`src/runTurnWiring.test.ts` 那句"边界如实记"：用测试承载一段注释，断言恒真），
     * 它是"看着像在测"的极端形态 —— 与那张表第一行想挡的东西是同一个。
     *
     * 所以三件事一起查：
     *   ① 一处断言都没有 → 红；
     *   ② 有断言，但**去掉注释后**全是"字面量自己等于自己"（`expect(true).toBe(true)`）→ 红；
     *   ③ 注释里写 `expect(` 不算数（这个坑本仓踩过多次）。
     */
    const VACUOUS =
      /\bexpect\s*\(\s*(true|false|null|undefined|-?\d+|["']{2})\s*\)\s*\.\s*to[A-Za-z]+\(\s*(true|false|null|undefined|-?\d+|["']{2})\s*\)/g;
    const offenders: string[] = [];
    const vacuousOnly: string[] = [];
    for (const file of files) {
      const relPath = rel(file);
      if (!/\.test\.(ts|tsx)$/.test(relPath)) continue;
      /* 去掉注释再数：注释里提 `expect(` 不是断言 */
      const text = readFileSync(file, "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^\s*\/\/.*$/gm, "");
      if (!/expect\s*\(|assert[.(]|assert\./.test(text)) {
        offenders.push(relPath);
        continue;
      }
      const vacuous = text.match(VACUOUS) ?? [];
      const all = text.match(/\bexpect\s*\(/g) ?? [];
      if (vacuous.length > 0 && vacuous.length >= all.length) {
        vacuousOnly.push(`${relPath}（${vacuous.length} 处恒真 / 共 ${all.length} 处断言）`);
      }
    }
    expect(
      offenders,
      ["这些文件是测试，但里面一处断言都没有（点名它当判据等于没判）：", ...offenders].join("\n"),
    ).toEqual([]);
    expect(
      vacuousOnly,
      [
        "这些测试文件里的断言**全是恒真的**（`expect(true).toBe(true)` 那种自己等于自己）——",
        "它跑起来永远是绿的，等于没测（把注释里的边界说明变成一条真判据，或干脆别叫它测试）：",
        ...vacuousOnly,
      ].join("\n"),
    ).toEqual([]);
  });

  it("⑤ 完成态断言（已接/已实现/已修复/只读不动…）必须点名判据或落豁免", () => {
    const offenders: string[] = [];
    for (const file of files) {
      const relPath = rel(file);
      if (/\.test\.(ts|tsx|mjs)$/.test(relPath)) continue;
      if (CLAIM_EXEMPT_FILES.has(relPath)) continue;
      const rows = readFileSync(file, "utf8").split("\n");
      for (const [i, line] of rows.entries()) {
        if (!COMMENT_LINE.test(line)) continue;
        if (!CLAIM_RE.test(line)) continue;
        /* 同一段（上下相邻的注释行）里点名了判据就算数 */
        let block = "";
        for (let j = i; j >= 0 && COMMENT_LINE.test(rows[j]!); j -= 1) block = `${rows[j]}\n${block}`;
        for (let j = i + 1; j < rows.length && COMMENT_LINE.test(rows[j]!); j += 1) block += `${rows[j]}\n`;
        if (JUDGE_MARK.test(block)) continue;
        offenders.push(`${relPath}:${i + 1} → ${line.trim().slice(0, 90)}`);
      }
    }
    expect(
      offenders,
      [
        "这些注释在断言「已经接上/已经做了/已经修好」，而同一段注释里**没有点名任何判据** —— 下一个人改动这里时，没有任何东西会替他响：",
        ...offenders,
        "",
        "两种处理：在注释里点名盯着它的测试（`xxx.test.ts` / `accept-xxx.mjs`），",
        "或写进本文件顶部的 `CLAIM_EXEMPT_FILES`（那条路要写清 why，而且名单卡总数）。",
      ].join("\n"),
    ).toEqual([]);
  });

  it("⑥ 插件词表两向对账：PLUGIN.md 与 engine/runtime/plugins.ts", () => {
    const doc = readFileSync(path.join(ROOT, "PLUGIN.md"), "utf8");

    /* 方向一：代码里的每个权限/钩子都得在文档里（不然用户照文档写不出能跑的插件） */
    const missingInDoc: string[] = [];
    for (const p of PLUGIN_PERMISSIONS) if (!doc.includes(p)) missingInDoc.push(`权限 ${p}`);
    for (const h of HOOK_NAMES) if (!doc.includes(h)) missingInDoc.push(`钩子 ${h}`);
    expect(missingInDoc, `这些能力在代码里有、PLUGIN.md 里没有（文档教不全）：${missingInDoc.join(" / ")}`).toEqual([]);

    /* 方向二：文档里写出来的 `a:b` 形态词必须都是代码里认识的（不然是教人用不存在的东西） */
    const known = new Set<string>([...PLUGIN_PERMISSIONS, ...HOOK_NAMES]);
    /* `npm:包名` 这类渠道前缀不是能力名，单独放行 */
    const docOnly = new Set(["npm:word"]);
    const unknown = new Set<string>();
    for (const m of doc.matchAll(/([a-z][a-z0-9]*:[a-z][a-z0-9]*)/g)) {
      const token = m[1]!;
      if (known.has(token) || docOnly.has(token)) continue;
      unknown.add(token);
    }
    expect([...unknown], `PLUGIN.md 里出现了代码不认识的「a:b」形态词：${[...unknown].join(" / ")}`).toEqual([]);

    /* 方向三：清单字段——从 PluginManifest 的类型体里取键，逐个要在文档里出现 */
    const pluginsSrc = readFileSync(path.join(ROOT, "engine/runtime/plugins.ts"), "utf8");
    const typeBody = /export type PluginManifest = \{([\s\S]*?)\n\};/.exec(pluginsSrc)?.[1] ?? "";
    const keys = [...typeBody.matchAll(/^\s{2}([a-z][A-Za-z0-9]*)\??:/gm)].map((m) => m[1]!);
    expect(keys.length, "PluginManifest 的字段列表解析不出来了 —— 这条守卫的判据本身就失效了").toBeGreaterThan(5);
    const missingKeys = keys.filter((k) => !doc.includes(k));
    expect(
      missingKeys,
      `PLUGIN.md 没写这些清单字段（照它写会装不上）：${missingKeys.join(" / ")}`,
    ).toEqual([]);
  });

  it("⑦ CLI 命令点名必须有人接（`ding <命令>` / `ding plugins <子命令>`）", () => {
    const ding = readFileSync(path.join(ROOT, "hosts/cli/ding.ts"), "utf8");
    /*
     * ⚠️ 2026-10-16（落地当轮补）：帮助那一屏**搬过家** —— 为了让 `ding.ts` 回到 900 行以内，
     * 用法串挪进了 `hosts/cli/help.ts`。这条守卫原来只读 `ding.ts`，于是当场红。
     * 这类红是**有用**的（它提醒"守卫要跟着搬"，本仓另一条守卫的注释里写着同一句话），
     * 但判据本身不该绑在一个文件的路径上：用法串是"CLI 帮助里说的话"，
     * 所以改成在 **`hosts/cli/**` 的全部源文件**里找；派发仍认 `ding.ts`（命令是在那里接的）。
     */
    const cliSources = readdirSync(path.join(ROOT, "hosts/cli"))
      .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
      .map((name) => readFileSync(path.join(ROOT, "hosts/cli", name), "utf8"))
      .join("\n");

    /* 顶层派发：`parsed.command === "x"` */
    const dispatch = new Set(
      [...ding.slice(ding.indexOf("async function main()")).matchAll(/parsed[.]command === "([a-z]+)"/g)].map((m) => m[1]!),
    );
    expect(dispatch.size, "顶层命令派发解析不出来了").toBeGreaterThan(10);

    /* 插件子命令：cmdPlugins 里的 `sub === "x"` */
    const pluginsBody = ding.slice(ding.indexOf("async function cmdPlugins"), ding.indexOf("function cmdConfig"));
    const subs = new Set([...pluginsBody.matchAll(/sub === "([a-z]+)"/g)].map((m) => m[1]!));
    expect(subs.size, "插件子命令解析不出来了").toBeGreaterThan(4);

    /*
     * 用法串与派发必须**相等**（两边任何一边漏写都要红）。
     * ⚠️ 仓里有两处 `ding plugins [...]`：文件头写的是 `[子命令]`（占位），
     * 帮助那一屏才是真清单 —— 所以取"子命令最多"的那一处来比。
     */
    const usageCandidates = [...cliSources.matchAll(/ding plugins \[([^\]]+)\]/g)].map((m) =>
      (m[1] ?? "")
        .split("|")
        .map((part) => part.trim().split(/\s+/)[0] ?? "")
        .filter((word) => /^[a-z-]+$/.test(word)),
    );
    const usageSubs = new Set(usageCandidates.sort((a, b) => b.length - a.length)[0] ?? []);
    expect(usageSubs.size, "帮助里的 ding plugins [...] 用法串解析不出来了").toBeGreaterThan(4);
    expect(
      [...usageSubs].sort().join(","),
      `帮助里的 ding plugins [...] 用法串与实现不是一套：用法串 ${[...usageSubs].sort().join(" / ")} vs 实现 ${[...subs].sort().join(" / ")}`,
    ).toBe([...subs].sort().join(","));

    /* 别名（`ding help` / 裸 `ding`）不算命令点错 */
    const alias = new Set(["help"]);
    const offenders: string[] = [];
    for (const file of files) {
      const relPath = rel(file);
      const rows = readFileSync(file, "utf8").split("\n");
      for (const [i, line] of rows.entries()) {
        for (const m of line.matchAll(/(?:^|[^A-Za-z0-9_-])ding ([a-z][a-z0-9-]*)/g)) {
          const word = m[1]!;
          if (dispatch.has(word) || alias.has(word)) continue;
          if (WRONG_CMD_MARK.test(line)) continue; // 注释本来就在讲一个打错的命令
          offenders.push(`${relPath}:${i + 1} → ding ${word}`);
        }
        for (const m of line.matchAll(/ding plugins ([a-z][a-z0-9-]*)/g)) {
          if (subs.has(m[1]!)) continue;
          if (WRONG_CMD_MARK.test(line)) continue; // 同上：这一行本来就在讲"那条命令不存在"
          offenders.push(`${relPath}:${i + 1} → ding plugins ${m[1]}（实现里没有这个子命令）`);
        }
      }
    }
    expect(
      offenders,
      [
        "文档/注释里写的命令，CLI 里没人接 —— 用户照着跑只会拿到「不认识的子命令」（审计 P206）：",
        ...offenders,
      ].join("\n"),
    ).toEqual([]);
  });

  it("豁免名单卡总数（只许少不许多）", () => {
    expect(ABSENT_JUDGE_FILES.size, "③ 的豁免只许往下调（修一处就把这条改小）").toBeLessThanOrEqual(MAX_ABSENT_JUDGE);
    expect(LOCAL_POINTER_FILES.size, "② 的豁免只许往下调").toBeLessThanOrEqual(MAX_LOCAL_POINTER);
    expect(CLAIM_EXEMPT_FILES.size, "⑤ 的豁免只许往下调").toBeLessThanOrEqual(MAX_CLAIM_EXEMPT);
    expect(PHANTOM_PATH_FILES.size, "① 的豁免只许往下调（它卡的是真缺陷的条数）").toBeLessThanOrEqual(MAX_PHANTOM_PATH_FILES);
    /* 名单里的文件必须还在（删了文件要顺手删名单） */
    for (const key of [
      ...ABSENT_JUDGE_FILES.keys(),
      ...LOCAL_POINTER_FILES.keys(),
      ...CLAIM_EXEMPT_FILES.keys(),
      ...PHANTOM_PATH_FILES.keys(),
    ]) {
      expect(existsSync(path.join(ROOT, key)), `豁免名单里列着已经不存在的文件：${key}`).toBe(true);
    }
    /* 每条都要有 why（名单存在的意义就是"为什么"） */
    for (const map of [ABSENT_JUDGE_FILES, LOCAL_POINTER_FILES, CLAIM_EXEMPT_FILES, PHANTOM_PATH_FILES]) {
      for (const [key, why] of map) expect(why.trim().length, `${key} 的 why 太短`).toBeGreaterThan(20);
    }
  });
});
