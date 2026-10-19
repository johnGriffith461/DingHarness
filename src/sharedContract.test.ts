import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { artifactStatusOf, ARTIFACT_STATUS } from "@shared/artifactProto";
import { filterApps, type CodingApp } from "@shared/coding";
import { humanFailure, classifyFailure } from "@shared/errors";
import { formatFileList } from "@shared/fileList";
import { ORIGIN_LABEL, ORIGIN_LABEL_FOR_MODEL, type DriveEntry } from "@shared/drive";
import { DEFAULT_SIZE_CHOICE, resolveChoice, resolveSize } from "@shared/imageSize";
import { mcpToolName, normalizeMcpConfig } from "@shared/mcp";
import { isTableDivider, parseMarkdown } from "@shared/minimark";
import { addMemory, clearMemory, removeMemory, normalizeMemory } from "@shared/memory";
import {
  EDIT_FILE_DESC,
  LIST_DIR_DESC,
  LIST_FILES_DESC,
  READ_FILE_DESC,
  REPEAT_VALUES as REPEAT_FROM_AGENT,
  RUN_COMMAND_DESC,
  SEARCH_FILES_DESC,
  WRITE_FILE_DESC,
} from "@shared/agentTools";
import { MAX_CUSTOM_MINUTES, MIN_CUSTOM_MINUTES, REPEAT_VALUES as REPEAT_FROM_SCHEDULE } from "@shared/schedule";

/**
 * 守卫：**第 6 单里落在 `shared/` 的那一族**（2026-10-16）。
 *
 * 这一族缺陷同形：**同一个事实长了两份实现/词表**，而它们之间没有任何东西在对账。
 * 所以每条判据都写成"两处必须一致"，而不是"这次的值是几"：
 * 改一处而忘了另一处 → 这里红。
 *
 * | 条 | 缺陷 | 判据 |
 * |---|---|---|
 * | ① | P57 `READ_FILE_MODEL_CHARS` 与 `MODEL_MAX_CHARS` 两份，模型看到的说明可能与实际行为分叉 | 直接读两处源码，抽出数字比相等 |
 * | ② | P56 两个 `READ_MAX_BYTES` 值不同（204800 / 200000） | 同上 |
 * | ③ | P58 `REPEAT_VALUES` 两份同名导出 | 必须是同一个数组（同一性，不比内容） |
 * | ④ | P58 custom 间隔上限在 schema 里裸写 | schema 的边界必须取自 `shared/schedule` 的两个常量 |
 * | ⑤ | P104 asset 的来源名两份（素材 / 生成图） | 工具清单里的来源名与界面表同源 |
 * | ⑥ | P60 `artifactStatusOf` 的词表与真实状态不相交 | 真实状态逐个对表，失败不许报成已生成 |
 * | ⑦ | P13 记忆开关被静默抹掉 | 三个写操作都要保住 `enabled` |
 * | ⑧ | P07 MCP 名塌缩后撞名 | 两个连接器不许撞成同一个工具名 |
 * | ⑨ | P102 裸数字子串当状态码 | `42913` 不算 429；`content-type` 不算审核 |
 * | ⑩ | P189 keepDetail 把上游原文整段糊到界面上 | 必须收口（一行、截断、标明是原文） |
 * | ⑪ | P244/P245 尺寸：0 被静默规整 / 小数比例算出巨值 key | 0 判无效；小数不参与整数约分 |
 * | ⑫ | P246 `filterApps` 的 `now` 默认 0 把时间筛选整个关掉 | 不传 `now` 也要真筛 |
 */

const ROOT = path.resolve(__dirname, "..");
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");

/** 从源码里抽一个 `export const NAME = <数字>`（支持 `200_000`、`200 * 1024` 两种写法）。 */
function numberConst(rel: string, name: string): number {
  const src = read(rel);
  const m = new RegExp(`export const ${name} = ([0-9_]+(?:\\s*\\*\\s*[0-9_]+)?)`).exec(src);
  expect(m, `${rel} 里找不到 export const ${name} —— 这条对账的判据本身失效了`).toBeTruthy();
  return m![1]!.split("*").reduce((acc, part) => acc * Number(part.replace(/_/g, "").trim()), 1);
}

const entry = (over: Partial<DriveEntry> = {}): DriveEntry => ({
  name: "封面.png",
  path: "D:/data/drive/封面.png",
  bytes: 1024,
  createdAt: 0,
  modifiedAt: 0,
  kind: "image",
  origin: "asset",
  ...over,
});

describe("shared/ 里那些「两份」必须对账（第 6 单）", () => {
  it("① 读文件给模型的字数上限：说明与真截断同值（P57）", () => {
    const inShared = numberConst("shared/agentTools.ts", "READ_FILE_MODEL_CHARS");
    const inEngine = numberConst("engine/runtime/tools/readTool.ts", "MODEL_MAX_CHARS");
    expect(
      inShared,
      `说明里写 ${inShared}、实际截到 ${inEngine} —— 模型照说明写、被拒绝，然后开始瞎猜`,
    ).toBe(inEngine);
  });

  it("② 云盘读文件与工具读文件的字节上限同值（P56）", () => {
    const inDrive = numberConst("shared/drive.ts", "READ_MAX_BYTES");
    const inTool = numberConst("engine/runtime/tools/readTool.ts", "READ_MAX_BYTES");
    expect(inDrive, `云盘那条上限 ${inDrive}、工具那条 ${inTool} —— 同一件事两个数`).toBe(inTool);
  });

  it("③ 重复方式的值表只有一份（P58）：agentTools 转出的就是 schedule 那份", () => {
    expect(REPEAT_FROM_AGENT, "又长出第二份 REPEAT_VALUES 了（同一个数组才说明只有一份）").toBe(REPEAT_FROM_SCHEDULE);
    expect([...REPEAT_FROM_SCHEDULE].length).toBe(5);
  });

  it("④ custom 间隔的上下界只有一份（P58）", () => {
    const src = read("shared/agentTools.ts");
    expect(src, "schema 里又裸写 5 了（应该用 MIN_CUSTOM_MINUTES）").not.toMatch(/\.min\(5\)\s*\n\s*\.max\(/);
    expect(src, "schema 里又裸写 60 * 24 * 30 了（应该用 MAX_CUSTOM_MINUTES）").not.toContain("max(60 * 24 * 30)");
    expect(src).toContain(".min(MIN_CUSTOM_MINUTES)");
    expect(src).toContain(".max(MAX_CUSTOM_MINUTES)");
    expect(MIN_CUSTOM_MINUTES).toBeLessThan(MAX_CUSTOM_MINUTES);
  });

  it("⑤ 来源名同源：工具清单里的 asset 与界面表一样叫素材（P104）", () => {
    const listed = formatFileList([entry()]);
    expect(listed, `工具留痕里的来源名与界面对不上：「${listed}」`).toContain(`在${ORIGIN_LABEL.asset}目录`);
    /* 表本身也要对得上（补了 drive 那一格，其它一个字不许改） */
    for (const key of ["artifact", "export", "asset"] as const) {
      expect(ORIGIN_LABEL_FOR_MODEL[key], `${key} 的名字被改成了另一个`).toBe(ORIGIN_LABEL[key]);
    }
    expect(ORIGIN_LABEL_FOR_MODEL.drive, "界面上空着的那一格，在留痕里要有个名字（否则是「在目录」）").not.toBe("");
  });

  it("⑥ 产物状态词表与真实状态对齐，失败不许报成已生成（P60）", () => {
    expect(artifactStatusOf("generating")).toBe(ARTIFACT_STATUS.Generating);
    expect(artifactStatusOf("generated")).toBe(ARTIFACT_STATUS.Generated);
    expect(artifactStatusOf("failed"), "失败的产物被报成「已生成」了").toBe(ARTIFACT_STATUS.Terminal);
    expect(artifactStatusOf("removed")).toBe(ARTIFACT_STATUS.Deleted);
    expect(artifactStatusOf(undefined)).toBe(ARTIFACT_STATUS.Generated);
    /* 真实状态那份词表（`src/workbench/artifact.ts`）里的每个值都得有归宿 */
    for (const real of ["generating", "generated", "failed"] as const) {
      expect(Number.isInteger(artifactStatusOf(real)), `${real} 没有映射`).toBe(true);
    }
  });

  it("⑦ 记忆的三个写操作都保住开关（P13）", () => {
    const off = { entries: [], enabled: false as const };
    expect(addMemory(off, "记住一条").enabled, "加一条之后开关没了 —— 重启后记忆自己开回来").toBe(false);
    const one = { entries: [{ id: "mem_1", text: "x", createdAt: "2026-01-01T00:00:00.000Z", source: "manual" as const }], enabled: false as const };
    expect(removeMemory(one, "mem_1").enabled, "删一条之后开关没了").toBe(false);
    expect(clearMemory(one).enabled, "清空之后开关没了").toBe(false);
    /* 不传库那条路（旧调用形状）仍然可用，只是会丢开关 —— 如实记在这里 */
    expect(clearMemory()).toEqual({ entries: [] });
    /* 规整那一层也要能把它读回来 */
    expect(normalizeMemory({ entries: [], enabled: false }).enabled).toBe(false);
  });

  it("⑧ 两个连接器塌缩成同一个工具名时，第二个不许进来（P07）", () => {
    const cfg = normalizeMcpConfig([
      { name: "my-server", command: "npx" },
      { name: "my_server", command: "npx" },
    ]);
    expect(cfg.servers.map((s) => s.name), "两个连接器撞成了同一个工具名").toEqual(["my-server"]);
    expect(mcpToolName("my-server", "count")).toBe(mcpToolName("my_server", "count"));
  });

  it("⑨ 状态码要独立、审核词要收紧（P102）", () => {
    /* 42913 里含 429，但那不是"限流"，真正的下一步是缩短输入 */
    expect(classifyFailure("maximum context length is 8192 tokens, however you requested 42913 tokens")).not.toBe("rate");
    /* 502 报错里带 content-type 是常态，不许被判成"内容审核没通过" */
    expect(classifyFailure("502 Bad Gateway: upstream sent bad content-type header")).toBe("upstream");
    expect(classifyFailure("fetch failed: ECONNREFUSED 127.0.0.1:8080 content-length missing")).toBe("network");
    /* 真的审核仍然要认得出来 */
    expect(classifyFailure("content policy violation: your request was rejected")).toBe("moderation");
    expect(classifyFailure("safety_violation detected")).toBe("moderation");
    /* 原来的四条不许被改坏 */
    expect(classifyFailure("429 Too Many Requests: insufficient balance")).toBe("quota");
    expect(classifyFailure("429 rate limit")).toBe("rate");
    expect(classifyFailure("404 model not found: gpt-404")).toBe("model");
  });

  it("⑩ keepDetail 附的原文要收口（P189）", () => {
    const raw = `上游 429 Too Many Requests ${"x".repeat(400)}\n第二行`;
    const got = humanFailure(raw, { keepDetail: true });
    expect(got).toContain("上游原文");
    expect(got, "原文里的换行被带进界面了（那会撑破卡片）").not.toContain("\n");
    const quoted = got.slice(got.indexOf("上游原文：") + "上游原文：".length);
    expect(quoted.length, "原文没有截断（400 字整段糊上去）").toBeLessThanOrEqual(301);
    /* 两条通道对同一个原因仍然说同一句话（13.1 的实质） */
    expect(got.startsWith(humanFailure(raw))).toBe(true);
  });

  it("⑪ 尺寸：0 判无效、小数不参与整数约分（P244 / P245）", () => {
    const zero = resolveChoice({ ...DEFAULT_SIZE_CHOICE, mode: "resolution", width: 0, height: 0 });
    expect(zero.invalid, "宽高填 0 仍被判有效 —— 会悄悄发一次 816x816 的真请求").toBe(true);
    expect(zero.size).toBe("");
    /* 小数比例：不该靠浮点 gcd 算出一个巨值 key（结果仍要落在合法档位里） */
    expect(resolveSize("1K", "2.39:1")).toBe("1920x800");
    expect(resolveSize("1K", "2.39:1")).toBe(resolveSize("1K", "239:100"));
  });

  it("⑫ filterApps 不传 now 也要真的筛时间（P246）", () => {
    const apps: CodingApp[] = [
      { name: "新的", path: "a.html", bytes: 1, updatedAt: Date.now(), category: "其他" },
      { name: "很久以前", path: "b.html", bytes: 1, updatedAt: Date.now() - 40 * 24 * 3600 * 1000, category: "其他" },
    ];
    expect(filterApps(apps, { days: 7 }).map((a) => a.name), "「近 7 天」没筛，列的是全部").toEqual(["新的"]);
    expect(filterApps(apps, { days: 0 }).length).toBe(2);
  });

  it("⑭ 表格误判：含竖线的句子 + `---` 不许被当成表格（P241）", () => {
    /* ① 含竖线的句子 + 一条 `---`（setext 下划线）：真标题不许消失、正文不许被吞成数据行 */
    const fake = parseMarkdown("方案 A | B\n---\n正文继续");
    expect(fake.some((b) => b.kind === "table"), "含竖线的句子 + `---` 被当成了表格").toBe(false);
    expect(fake.map((b) => ("text" in b ? b.text : "")).join(" "), "那段正文被吞掉了").toContain("正文继续");
    const fake2 = parseMarkdown("营收 | 成本\n---\n正文继续");
    expect(fake2.some((b) => b.kind === "table")).toBe(false);

    /* ② 真表格仍然要进（别把判据收紧到看不见真东西） */
    const real = parseMarkdown("| 项目 | 数值 |\n|---|---|\n| 访问量 | 1200 |");
    expect(real[0]).toEqual({ kind: "table", header: ["项目", "数值"], rows: [["访问量", "1200"]] });
    /* 不带首尾竖线、对齐符那种写法也要照样认 */
    const real2 = parseMarkdown("项目 | 数值\n:--|--:\n访问量 | 1200");
    expect(real2[0]).toMatchObject({ kind: "table", header: ["项目", "数值"] });

    /* ③ 分隔行的判据本身 */
    expect(isTableDivider("---"), "单个 `---` 被认成表格分隔行了").toBe(false);
    expect(isTableDivider("|--|--|")).toBe(true);
    /* ④ 列数对不上不算表格（`a | b | c` 三列、分隔行两列） */
    expect(parseMarkdown("a | b | c\n|---|---|").some((b) => b.kind === "table")).toBe(false);
  });

  it("⑬ 契约注释里说的缺省档，必须就是实现里的缺省档（P96）", () => {
    const src = read("shared/ipc.ts");
    /*
     * 判据是"两处对齐"，不是"文案是某一句"：从 `normalizeConfirmMode` 里抽出**真的缺省值**，
     * 再要求 `toolPolicy` 那段注释写的也是它。改实现不改注释（或反过来）都会红。
     */
    const fallback = /return CONFIRM_MODES\.includes\(raw as ConfirmMode\) \? \(raw as ConfirmMode\) : "([^"]+)"/.exec(src);
    expect(fallback, "normalizeConfirmMode 的缺省值解析不出来了").toBeTruthy();
    const doc = src.slice(src.indexOf("审批档位（§143）"), src.indexOf("toolPolicy?: ConfirmMode;"));
    expect(doc, `契约注释没写实现里那一档（${fallback![1]}）—— 读契约的人会按旧事实行事`).toContain(fallback![1]!);
    expect(doc, "注释里还留着 Phase 11.5 之前那句「省略按全部允许」").not.toContain("省略按「全部允许」");
  });
});

describe("A4 工具说明是工作区心智（不是云盘助手）", () => {
  const fileTools: Array<[string, string]> = [
    ["list_files", LIST_FILES_DESC],
    ["read_file", READ_FILE_DESC],
    ["write_file", WRITE_FILE_DESC],
    ["list_dir", LIST_DIR_DESC],
    ["search_files", SEARCH_FILES_DESC],
    ["edit_file", EDIT_FILE_DESC],
    ["run_command", RUN_COMMAND_DESC],
  ];

  it("⭐ 文件/命令类工具说明都指向工作区或授权目录，且没有空说明", () => {
    for (const [name, desc] of fileTools) {
      expect(desc.trim(), `${name} 的说明是空的`).not.toBe("");
      expect(desc, `${name} 的说明还在用云盘/产物目录的心智`).toMatch(/工作区|授权目录/);
    }
  });

  it("⭐ 源码里不再出现「云盘 / 产物」这种旧口径（drive 工具除外）", () => {
    expect(read("shared/agentTools.ts")).not.toContain("云盘 / 产物");
  });

  it("读文件说明写了分页与失败路径", () => {
    expect(READ_FILE_DESC).toContain("offset");
    expect(READ_FILE_DESC).toContain("二进制");
    expect(READ_FILE_DESC).toContain("过期");
  });

  it("改文件说明要求先读、并写清过期内容会被拒", () => {
    expect(EDIT_FILE_DESC).toContain("编辑前先 read_file");
    expect(EDIT_FILE_DESC).toContain("拒绝");
    expect(WRITE_FILE_DESC).toContain("优先用 edit_file");
  });

  it("搜索说明讲清是正则/关键词，不是语义搜索", () => {
    expect(SEARCH_FILES_DESC).toContain("不是语义搜索");
    expect(SEARCH_FILES_DESC).toContain("include");
  });

  it("跑命令说明要求用它验证改动", () => {
    expect(RUN_COMMAND_DESC).toContain("跑相关测试或构建");
    expect(RUN_COMMAND_DESC).toContain("2000 行");
  });
});
