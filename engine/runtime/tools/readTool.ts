import fs from "node:fs/promises";
import path from "node:path";
import { insideDirs } from "./drivePaths";

/**
 * 「读文件」工具的执行体（2026-10-14）。
 *
 * ## 为什么单独一个文件
 * 与 `drivePaths.ts` 同一个理由：这个文件**只依赖 `node:` 与纯函数**，
 * 不 `import electron` —— 于是它能在 `src/**` 的 vitest 里被直接调用做真断言
 * （主进程那边的 vitest 配置收不到）。边界判断、截断、各种"读不到"的分支
 * 都能在这里被钉住，不用真启一个应用。
 *
 * ## 与 `drive:read` 是**同一道边界**
 * 目录白名单走同一个 `insideDirs`，大小上限沿用同一个数 ——
 * 两边各写一份的话，"界面上能读的"和"agent 能读的"迟早会分叉，
 * 而分叉的方向通常是**其中一边变松**（那才是危险的那边）。
 */

/**
 * 一次读取的字节上限：与 `drive:read` 一致（超过就不读，别把几兆塞进内存）。
 *
 * ⚠️ 它同时是**写入与改动的上限**（审计 P234）：`writeTool.WRITE_MAX_BYTES` 与
 * `editTool.EDIT_MAX_BYTES` 都直接取这个数，所以"写得进去的东西一定读得回来、
 * 改得动"是一条能证明的不变量，而不是三个数碰巧一样大。
 * 与 `shared/drive.ts` 那个同值由 `src/sharedContract.test.ts ②` 对账。
 */
export const READ_MAX_BYTES = 200_000;

/** 给模型的正文上限（超出截断，并注明原文长度）。 */
export const MODEL_MAX_CHARS = 8000;

/** 读文件的结果。 */
export type ReadFileResult =
  | {
      ok: true;
      text: string;
      chars: number;
      truncated: boolean;
      totalChars: number;
      /** 这段正文从第几行开始（1 基；未分页时是 1）。 */
      fromLine?: number;
      /** 原文总行数（分页时给模型一个"还有多少"的锚）。 */
      totalLines?: number;
    }
  | { ok: false; error: string };

/** 按文件名找文件时最多往下看几层目录（云盘是浅结构，深挖没意义）。 */
const NAME_SEARCH_DEPTH = 3;

/**
 * 按**文件名**在可读目录里找文件（2026-10-14 补）。
 *
 * ## 为什么需要
 * `read_file` 一开始只认绝对路径 —— 可模型**根本不知道路径**：
 * 用户说"把云盘里的季度总结.md 读一下"，模型手上只有这个名字，
 * 而文件实际在 `<userData>/drive/季度总结.md`。于是这个工具在真实场景里用不起来
 * （只有"用户把完整路径给了它"这一种情况能 work）。
 *
 * @param name 文件名；可以带子目录（如 `报告/季度.md`）
 * @param dirs 可读目录白名单
 * @returns 命中的绝对路径（可能多个；由调用方决定"多个怎么办"）
 */
export async function findByFileName(name: string, dirs: readonly string[]): Promise<string[]> {
  const wanted = name.replace(/\\/g, "/").replace(/^\.\//, "");
  const hits: string[] = [];

  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > NAME_SEARCH_DEPTH) return;
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return; /* 读不了的目录跳过（不是错误：可能刚被删） */
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full, depth + 1);
        continue;
      }
      const normalized = full.replace(/\\/g, "/");
      if (wanted.includes("/") ? normalized.endsWith(`/${wanted}`) : entry.name === wanted) {
        hits.push(full);
      }
    }
  };

  for (const dir of dirs) await walk(dir, 1);
  return hits;
}

/**
 * 读文件的可选项。
 *
 * ⚠️ 参数从一串位置参数收成一个对象（U02）：这一轮加了三个互相独立的维度
 * （额外只读根、分页、两种大小上限），继续往后排位置会让每个调用点在
 * "第 4 个参数是什么"上出错 —— 而它是**权限边界**上的函数，错一次就是放行错一次。
 */
export type ReadFileOptions = {
  /** 给模型的正文上限（默认 8000 字）。 */
  maxChars?: number;
  /**
   * **额外的只读根目录**（U02）：工具结果落盘目录。
   *
   * 它只加"能读"，不加"能写/能改/能跑" —— 落盘文件是**我们自己的证据**，
   * 让模型回读它是这条功能的目的；而写入仍然只认用户授权的目录。
   * 路径校验走同一个 `insideDirs`（按真实路径比），符号链接穿不出去。
   */
  extraReadDirs?: readonly string[];
  /** 分页：从第几行开始（1 基）与最多读几行。省略 = 从头读。 */
  page?: { offset?: number; limit?: number };
  /**
   * 用户文件的大小上限（默认 `READ_MAX_BYTES`）。
   *
   * 宿主接了落盘之后会给一个更大的值：**大文件恰恰是落盘功能存在的理由**，
   * 用 200KB 把它挡在门外，等于"证据存下来了但根本进不了落盘这条路"。
   */
  maxBytes?: number;
  /** 落在额外只读根里的文件上限（默认 64MB）。 */
  extraMaxBytes?: number;
};

/**
 * 读一个用户目录里的文本文件，读成"给模型看的样子"。
 *
 * ⚠️ **失败一律如实回报**（哪一步失败、为什么），不返回空串：
 * 模型的默认行为是"看不到就猜"，而一句准确的"读不到，因为 X"能让它说实话
 * 或者换一条路（12-factor 的 Factor 9：错误要压缩成上下文的一部分）。
 *
 * @param rawPath 模型给过来的路径（**不可信**）
 * @param dirs 允许读取的目录白名单（绝对路径）
 * @param opts 上限 / 额外只读根 / 分页（见 `ReadFileOptions`）
 * @returns 读到的正文，或者一条说清原因的失败
 */
export async function readFileForModel(
  rawPath: string,
  dirs: readonly string[],
  opts: ReadFileOptions = {},
): Promise<ReadFileResult> {
  const maxChars = opts.maxChars ?? MODEL_MAX_CHARS;
  const extraReadDirs = opts.extraReadDirs ?? [];
  const page = opts.page ?? {};
  /** 两条入口共用同一段"先按路径、再按名字"的解析（别在分页后漏掉校验）。 */
  const resolved = await resolveReadable(rawPath, dirs, extraReadDirs);
  if (!resolved.ok) return resolved;
  /*
   * 落盘文件**一律按模型的单次上限切**（U02）：
   * 它是"完整证据"，一次读回来几兆没有意义 —— 要么按行分页，要么让调用方
   * 只拿到开头一段 + 行数锚点。用户文件则不在这里收：宿主会用更大的上限
   * 先把全文读进来，再由 `applySpill` 决定落盘与回注。
   */
  const cap = resolved.viaExtra ? Math.min(maxChars, MODEL_MAX_CHARS) : maxChars;
  return readResolved(
    resolved.path,
    cap,
    page,
    resolved.viaExtra ? (opts.extraMaxBytes ?? SPILL_READ_MAX_BYTES) : (opts.maxBytes ?? READ_MAX_BYTES),
  );
}

/** 落盘文件允许回读的大小上限（工具输出本来就可能几兆）。 */
export const SPILL_READ_MAX_BYTES = 64 * 1024 * 1024;

/**
 * 宿主接了落盘时，**用户文件**允许读入内存的上限。
 *
 * 为什么是 16MB 而不是 `READ_MAX_BYTES`（200KB）：大文件恰恰是落盘功能存在的理由 ——
 * 200KB 的日志只有两千多行，撞不到"5 万行"那个场景。这个数只影响
 * "一次读进内存"的上限，**不**影响发给模型的量（那由 8000 字 + 落盘预览决定）。
 */
export const AGENT_READ_MAX_BYTES = 16 * 1024 * 1024;

/** 路径解析的结果。 */
type ResolvedRead =
  | { ok: true; path: string; viaExtra: boolean }
  | { ok: false; error: string };

/**
 * 把模型给的路径解析成**已通过校验**的绝对路径。
 *
 * 抽出来之后，分页那条路与不分页那条走的是同一段校验 ——
 * 早先两个入口各写一遍时，"按名字找到的路径"少过一道检查（见本文件历史）。
 */
async function resolveReadable(
  rawPath: string,
  dirs: readonly string[],
  extraReadDirs: readonly string[],
): Promise<ResolvedRead> {
  /*
   * 先按路径认；认不出来、而且给的**不是绝对路径**时，再按名字找一次。
   * 顺序很重要：路径能认出来就别用名字搜（同名文件可能有多个）。
   * 为什么需要这一步见 `findByFileName` 的说明 —— 模型经常只知道文件名。
   */
  const byPath = insideDirs(rawPath, dirs);
  if (byPath) return { ok: true, path: byPath, viaExtra: false };
  const byExtra = insideDirs(rawPath, extraReadDirs);
  if (byExtra) return { ok: true, path: byExtra, viaExtra: true };
  if (!path.isAbsolute(rawPath)) {
    const hits = await findByFileName(rawPath, dirs);
    if (hits.length === 1) return { ok: true, path: hits[0], viaExtra: false };
    if (hits.length > 1) {
      /*
       * ⚠️ 同名多个**不猜**：把候选原样给模型（它才知道该读哪一个）。
       * 猜一个读下去是最坏的结果 —— 读错了文件还理直气壮地总结。
       */
      return {
        ok: false,
        error: `找到 ${hits.length} 个同名文件，请用完整路径指定一个：${hits.join(" / ")}`,
      };
    }
    return { ok: false, error: `没找到叫「${rawPath}」的文件（也可以直接给完整路径）` };
  }
  /* 走到这里 = 既不在白名单、也不在额外只读根、也不是"按名字找"那条路 */
  return {
    ok: false,
    error: "这个路径不在可读范围内（只能读用户的云盘 / 产物 / 导出目录，以及工具结果的落盘文件）",
  };
}

/**
 * 读一个**已经通过校验**的绝对路径。
 *
 * 抽出来是为了让两条入口（给的路径 / 按名字找到的路径）共用同一段
 * "stat → 大小 → 读 → 二进制判定 → 截断" —— 否则"按名字找"那条迟早会少一步检查。
 *
 * @param target 已通过白名单校验的绝对路径
 * @param maxChars 给模型的正文上限
 * @returns 读到的正文，或者一条说清原因的失败
 */
async function readResolved(
  target: string,
  maxChars: number,
  page: { offset?: number; limit?: number } = {},
  maxBytes: number = READ_MAX_BYTES,
): Promise<ReadFileResult> {
  let stat;
  try {
    stat = await fs.stat(target);
  } catch {
    return { ok: false, error: "文件不存在，或者读不了（检查一下路径）" };
  }
  if (stat.isDirectory()) {
    /* 目录不是"读不到"，而是"这个工具不干这个" —— 说清区别，模型才不会反复试。 */
    return { ok: false, error: "这是一个目录，不是文件" };
  }
  if (stat.size > maxBytes) {
    return { ok: false, error: `文件太大（${Math.round(stat.size / 1024)}KB，上限 ${Math.round(maxBytes / 1024)}KB）` };
  }

  let text: string;
  try {
    text = await fs.readFile(target, "utf8");
  } catch {
    return { ok: false, error: "读出错（可能是二进制文件或编码不是 UTF-8）" };
  }

  /*
   * 二进制文件用 utf8 强读会得到一堆替换字符（U+FFFD）——
   * 与其把垃圾喂给模型，不如直说"这像是二进制文件"。
   * 判据：替换字符占比超过 1%（正常文本几乎不会有）。
   */
  const replacement = (text.match(/\uFFFD/g) ?? []).length;
  if (text.length > 0 && replacement / text.length > 0.01) {
    return { ok: false, error: "这看起来是二进制文件（不是文本），读不了" };
  }

  const total = text.length;
  /*
   * 分页（U02）：落盘的大结果要用 `read_file` 一段一段读回来。
   *
   * 行号是 **1 基**（与编辑器、`sed -n`、报错信息一致）；`offset` 越界时钳住而不是报错 ——
   * 模型算错一行的代价不该是"这一轮白跑"，而"从末尾开始读"是它想要的那件事。
   */
  const allLines = text.split("\n");
  const offset = Number.isFinite(page.offset) && (page.offset ?? 0) > 0 ? Math.floor(page.offset as number) : 1;
  const limit = Number.isFinite(page.limit) && (page.limit ?? 0) > 0 ? Math.floor(page.limit as number) : undefined;
  const from = Math.min(Math.max(1, offset), Math.max(1, allLines.length));
  const sliced = limit === undefined ? allLines.slice(from - 1) : allLines.slice(from - 1, from - 1 + limit);
  const paged = sliced.join("\n");
  const pagedTotal = paged.length;

  const truncated = pagedTotal > maxChars;
  const shown = truncated ? paged.slice(0, maxChars) : paged;
  return {
    ok: true,
    text: shown,
    chars: shown.length,
    truncated,
    totalChars: total,
    fromLine: from,
    totalLines: allLines.length,
  };
}

/** 工具返回给模型的那一句话（成败都在这儿收口，界面上那行留痕也用它）。 */
export function describeReadResult(result: ReadFileResult, filePath: string): string {
  const name = path.basename(filePath);
  if (!result.ok) return `读不了「${name}」：${result.error}`;
  const where =
    result.fromLine !== undefined && result.totalLines !== undefined && result.fromLine > 1
      ? `第 ${result.fromLine} 行起（共 ${result.totalLines} 行）、`
      : "";
  if (result.truncated) {
    return `读了「${name}」（${where}前 ${result.chars} 字，原文 ${result.totalChars} 字）`;
  }
  return `读了「${name}」（${where}${result.chars} 字）`;
}
