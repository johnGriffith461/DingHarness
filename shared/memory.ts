/**
 * 「记忆」的本地模型。
 *
 * 依据本体路由 `chat/memory/list` / `clear` / `delete`
 * —— 它**有服务端接口，也就说明它是一个真实功能**。
 * 而我原来在设置里写的是"记忆需要账号服务端，本机版没有"，那是**错误的说法**：
 * 记忆的内容（用户让助手长期记住的事）完全可以存在本地。
 *
 * 这一版把记忆做成**本地存储 + 列表 / 清除 / 删除**三件事，
 * 与本体那三条接口对应。
 */

/** 一条记忆。 */
export type MemoryEntry = {
  /** 稳定 id。 */
  id: string;
  /** 记忆正文（一句话，助手每次对话时会看到的）。 */
  text: string;
  /** 创建时间（ISO）。 */
  createdAt: string;
  /** 来源：手动添加，或从某次对话里存下来。 */
  source: "manual" | "conversation";
  /** `source === "conversation"` 时的来源任务标题，便于回溯。 */
  fromTask?: string;
};

/** 记忆库。 */
/**
 * 记忆库。
 *
 * ⚠️ `enabled`（§182）：设置里那个「记忆」开关。
 *
 * 关掉之后**不再注入系统提示词** —— 是「不注入」，不是「删掉」：
 * 条目还在，随时开回来（开回来之后原来记的照样在）。
 */
export type MemoryLib = {
  /** 条目，新的在前。 */
  entries: MemoryEntry[];
  /** 记忆开关（默认开）。 */
  enabled?: boolean;
};

/** 空库。 */
export const EMPTY_MEMORY: MemoryLib = { entries: [] };

/** 单条记忆的长度上限 —— 记忆是"要长期记住的短句"，不是文档。 */
export const MEMORY_TEXT_LIMIT = 200;

/** 条数上限，防止无限堆积把系统提示词撑爆。 */
export const MEMORY_MAX = 100;

/**
 * 把任意读回来的东西规整成合法的记忆库。
 *
 * 与 `normalizeLibrary` 同一个思路：**磁盘上的东西不可信**，
 * 缺字段、类型不对、超长、重复都要在这一层挡掉，后面的代码才可以当真。
 *
 * @param raw 从磁盘读回的值
 * @returns 合法的记忆库
 */
export function normalizeMemory(raw: unknown): MemoryLib {
  const list = (raw as { entries?: unknown } | null)?.entries;
  /*
   * ⚠️ `enabled` 必须一起恢复（§182）：否则在设置里关掉记忆，
   * **重启之后它又自己开回来了** —— 用户会觉得那个开关根本没用。
   */
  const keepEnabled = (raw as { enabled?: unknown } | null)?.enabled === false ? { enabled: false as const } : {};
  if (!Array.isArray(list)) return { entries: [...EMPTY_MEMORY.entries], ...keepEnabled };

  const seen = new Set<string>();
  const entries: MemoryEntry[] = [];

  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const e = item as Partial<MemoryEntry>;
    const text = typeof e.text === "string" ? e.text.trim() : "";
    const id = typeof e.id === "string" && e.id ? e.id : "";
    if (!text || !id) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    entries.push({
      id,
      text: text.slice(0, MEMORY_TEXT_LIMIT),
      createdAt: typeof e.createdAt === "string" && e.createdAt ? e.createdAt : new Date(0).toISOString(),
      source: e.source === "conversation" ? "conversation" : "manual",
      ...(typeof e.fromTask === "string" && e.fromTask ? { fromTask: e.fromTask } : {}),
    });
    if (entries.length >= MEMORY_MAX) break;
  }

  /*
   * 新的在前。
   *
   * ⚠️ 必须给相同 `createdAt` 一个**确定的次序**（这里用 id 兜底）。
   * 第一版写成 `a.createdAt < b.createdAt ? 1 : -1` —— 相等时也返回 -1，
   * **不是合法全序**，`Array.prototype.sort` 会给出任意顺序，
   * 于是"规整过的库再规整一次"结果会变（测试逮到了）。
   * 同一毫秒加两条记忆是很常见的（批量导入），不是边角情况。
   */
  entries.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
  return { entries, ...keepEnabled };
}

/**
 * 加一条记忆。
 *
 * **重复正文不加第二遍** —— 用户手动加和从对话里存的，很多会是同一句话；
 * 留两份会让助手在提示词里看到重复内容。
 *
 * @param lib 现有库
 * @param text 正文
 * @param options 来源与来源任务
 * @returns 新库（不改原对象）
 */
export function addMemory(
  lib: MemoryLib,
  text: string,
  options: { source?: MemoryEntry["source"]; fromTask?: string } = {},
): MemoryLib {
  const trimmed = text.trim().slice(0, MEMORY_TEXT_LIMIT);
  if (!trimmed) return lib;
  if (lib.entries.some((e) => e.text === trimmed)) return lib;

  const entry: MemoryEntry = {
    id: `mem_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
    text: trimmed,
    createdAt: new Date().toISOString(),
    source: options.source === "conversation" ? "conversation" : "manual",
    ...(options.fromTask ? { fromTask: options.fromTask } : {}),
  };

  const entries = [entry, ...lib.entries].slice(0, MEMORY_MAX);
  /*
   * ⚠️ `...lib` 不是为了好看（审计 P13）：`enabled` 那个开关与条目住在同一个对象里，
   * 只回 `{ entries }` 会把「用户在设置里关掉了记忆」这件事**静默抹掉** ——
   * 落盘之后 `memoryPromptBlock` 就判不出关，下一轮记忆又会被塞回提示词里。
   */
  return { ...lib, entries };
}

/**
 * 删一条。
 *
 * @param lib 现有库
 * @param id 要删的 id
 * @returns 新库（**保住 `lib` 上的其它字段**，见 P13）
 */
export function removeMemory(lib: MemoryLib, id: string): MemoryLib {
  return { ...lib, entries: lib.entries.filter((e) => e.id !== id) };
}

/**
 * 清除全部。
 *
 * ⚠️ 把**当前的库**传进来（审计 P13）：`enabled` 与条目住在同一个对象里，
 * 只回 `{ entries: [] }` 会把「记忆已关掉」一起抹掉。不传也能编译（旧调用点还在），
 * 但那条路会丢开关 —— 两份调用点（`src/workbench/memoryStore.ts` 的 `clear()`、
 * `electron/ipc/memoryStore.ts` 的 `MEMORY_CHANNEL.clear`）要传当前库。
 *
 * @param lib 当前的库；不传 = 只给一份空库（会丢 `enabled`）
 * @returns 空库
 */
export function clearMemory(lib?: MemoryLib): MemoryLib {
  return lib ? { ...lib, entries: [] } : { entries: [] };
}

/**
 * 注入系统提示词那一块的**字符上限**（§164）。
 *
 * 这一块是**每一轮都要塞进系统提示词**的：条数上限 100 × 单条 200 字 ≈ 2 万字/轮 ——
 * 那会把上下文吃掉一大半，而用户感觉不到代价。
 *
 * 取值理由：1500 字大约能展开 10~20 条短记忆，对"长期偏好"这个用途足够了。
 *
 * ⚠️ 这份文件在第 150 行左右已经有一个 `MEMORY_MAX`（条数上限），
 * 两者是**不同维度**的闸：条数管"最多存多少"，字数管"每轮最多说多少"。
 */
export const MEMORY_BLOCK_CHARS = 1500;

/**
 * 记忆注入系统提示词的那一段。
 *
 * 与 `enabledPromptBlock` 同一个位置 —— 都是"这次对话开始前要先告诉模型的事"。
 * 空库返回空串，调用方拼进去也不会多出多余空行。
 *
 * ⚠️ **超过字数上限时如实说明"还有 N 条未展开"**（§164）：
 * 静默截断会让模型把"没在上下文里"当成"没这回事"（§147 的同一条要求）。
 * 条目本来就是**新的在前**，所以先展开最近记的。
 *
 * @param lib 记忆库
 * @param limitChars 注入的字数上限
 * @returns 可直接拼接的文本（可能为空串）
 */
export function memoryPromptBlock(lib: MemoryLib, limitChars = MEMORY_BLOCK_CHARS): string {
  /*
   * ⚠️ 关掉了就不注入（§182）。
   *
   * 这是设置里那个开关**唯一的真效果** —— 不接上的话，
   * 那个开关就只是「看着有、其实没用」。
   */
  if (lib?.enabled === false) return "";
  if (lib.entries.length === 0) return "";
  const head = "【长期记忆】以下是用户希望你长期记住的事：";
  const lines: string[] = [];
  let used = head.length;
  let dropped = 0;
  for (const e of lib.entries) {
    const line = `- ${e.text}`;
    // 至少展开一条（哪怕它超了上限）：一条都不给比多占点字更糟
    if (lines.length > 0 && used + line.length > limitChars) {
      dropped += 1;
      continue;
    }
    lines.push(line);
    used += line.length + 1;
  }
  const more = dropped > 0 ? `\n（另有 ${dropped} 条记忆未展开：本次注入的字数上限是 ${limitChars}）` : "";
  return `${head}\n${lines.join("\n")}${more}`;
}
