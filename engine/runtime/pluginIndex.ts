/**
 * 插件市场索引（V6-3d）。
 *
 * ## 它解决什么
 *
 * 在这之前，"能装插件"的前提是**你已经知道插件叫什么、在哪个 npm 包** ——
 * 发现这一步是断的。市场索引补的就是这一步：一个 format-1 的 JSON，
 * 列出插件、版本、兼容范围与安装来源，CLI/界面搜得到。
 *
 * ## 索引不是信任
 *
 * 索引只回答"有哪些插件、去哪装"。**信任仍由签名与安装时的验签决定**
 * （`pluginSignature.ts` + `pluginTrust.ts`）：索引里写"这是官方的"没有任何意义，
 * 装的时候验不过就是装不上。
 *
 * ## 兼容门（`engines.ding`）
 *
 * 原来 `engines.ding` 只校验"是不是非空字符串"，装载/安装时**从不比较**版本 ——
 * 声明了却不生效，等于没有。这里补上范围判断：不兼容的条目照样**列出来**
 * （用户有权知道它存在），但标成不兼容并说明原因，安装被拒。
 */

/** 索引格式版本（改结构必须升版本）。 */
export const PLUGIN_INDEX_FORMAT = 1;

/** 索引里的一个插件。 */
export type PluginIndexEntry = {
  id: string;
  name: string;
  version: string;
  description?: string;
  publisher?: string;
  /** 兼容的宿主版本范围（与 manifest 的 `engines.ding` 同义）。 */
  enginesDing: string;
  tags?: string[];
  homepage?: string;
  /** 安装来源：npm 包名（CLI 会补 `npm:` 前缀）。 */
  npm?: string;
  /**
   * 安装来源：本地目录（相对**索引文件**所在目录）。
   *
   * 只对本地索引有效 —— **远程索引里的 `local` 会被忽略**：
   * 否则一个远端索引就能让用户从自己机器上任意路径装代码（那是一条提权路径）。
   * 用途：仓内示例与离线演示（`plugin-samples/word-count`）。
   */
  local?: string;
};

/** 一份索引。 */
export type PluginIndex = {
  format: number;
  updatedAt?: string;
  plugins: PluginIndexEntry[];
};

/** 解析结果（坏条目**跳过并报出**，不静默吞）。 */
export type PluginIndexParse =
  | { ok: true; index: PluginIndex; problems: string[] }
  | { ok: false; errors: string[] };

/**
 * 版本号（`x` / `x.y` / `x.y.z` 都认，缺的位补 0）。
 *
 * 为什么允许 `x` / `x.y`：范围写法里 `~1` / `^0.2` 是常见形状，
 * 不认它们就只能把"看不懂"当不兼容 —— 会把本来兼容的插件挡在门外。
 */
export function parseVersion(text: string): [number, number, number] | null {
  const m = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?$/.exec(String(text ?? "").trim());
  if (!m) return null;
  return [Number(m[1]), Number(m[2] ?? 0), Number(m[3] ?? 0)];
}

function cmp(a: [number, number, number], b: [number, number, number]): number {
  for (let i = 0; i < 3; i += 1) {
    if (a[i]! !== b[i]!) return a[i]! < b[i]! ? -1 : 1;
  }
  return 0;
}

/** 一个比较子（`>=1.2.3` / `^1.2` / `1.2.3` / `*`）。 */
function satisfiesOne(range: string, version: [number, number, number]): boolean {
  const text = range.trim();
  if (!text || text === "*" || text.toLowerCase() === "x") return true;

  if (text.startsWith("^")) {
    const base = parseVersion(text.slice(1));
    if (!base) return false;
    if (cmp(version, base) < 0) return false;
    /* caret：0.x 时下一位是破坏位（0.2→0.3），0.0.z 时补丁位是破坏位 */
    const [maj, min] = base;
    const upper: [number, number, number] = maj > 0 ? [maj + 1, 0, 0] : min > 0 ? [0, min + 1, 0] : [0, 0, base[2] + 1];
    return cmp(version, upper) < 0;
  }
  if (text.startsWith("~")) {
    const base = parseVersion(text.slice(1));
    if (!base) return false;
    if (cmp(version, base) < 0) return false;
    /* tilde：只允许补丁位变（~1.2.3 → <1.3.0；~1 → <2.0.0） */
    const parts = text.slice(1).split(".");
    const upper: [number, number, number] = parts.length >= 2 ? [base[0], base[1] + 1, 0] : [base[0] + 1, 0, 0];
    return cmp(version, upper) < 0;
  }

  const op = /^(>=|<=|>|<|=)/.exec(text)?.[1] ?? "=";
  const base = parseVersion(text.slice(op === "=" ? 0 : op.length));
  if (!base) return false;
  const c = cmp(version, base);
  switch (op) {
    case ">=":
      return c >= 0;
    case "<=":
      return c <= 0;
    case ">":
      return c > 0;
    case "<":
      return c < 0;
    default:
      return c === 0;
  }
}

/**
 * `engines.ding` 范围判断。
 *
 * 支持：`*`、精确版本、`>=` `>` `<=` `<` `=`、`^`、`~`、空格分隔的 AND、`||` 分隔的 OR。
 * 不支持的一律**当不兼容**（保守）—— 把"看不懂的范围"当兼容会让插件在没验证过的宿主上跑。
 *
 * @param range 清单/索引里的范围
 * @param hostVersion 宿主版本（`PRODUCT_VERSION`）
 * @returns 兼容返回 true
 */
export function satisfiesEngines(range: string, hostVersion: string): boolean {
  const version = parseVersion(hostVersion);
  const text = String(range ?? "").trim();
  if (!version) return false;
  if (!text) return false;
  return text.split("||").some((orPart) => {
    const parts = orPart.trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return false;
    return parts.every((one) => satisfiesOne(one, version));
  });
}

/** 收窄一条索引条目（磁盘/网络内容按不可信处理）。 */
function normalizeEntry(raw: unknown): { entry?: PluginIndexEntry; problem?: string } {
  if (!raw || typeof raw !== "object") return { problem: "条目不是对象" };
  const e = raw as Record<string, unknown>;
  const id = typeof e.id === "string" ? e.id.trim() : "";
  const name = typeof e.name === "string" ? e.name.trim() : id;
  const version = typeof e.version === "string" ? e.version.trim() : "";
  const enginesDing = typeof e.enginesDing === "string" ? e.enginesDing.trim() : "";
  if (!id) return { problem: "缺 id" };
  if (!parseVersion(version)) return { problem: `${id}：version 不是 x.y.z` };
  if (!enginesDing) return { problem: `${id}：缺 enginesDing` };
  const npm = typeof e.npm === "string" ? e.npm.trim() : undefined;
  const local = typeof e.local === "string" ? e.local.trim() : undefined;
  if (!npm && !local) return { problem: `${id}：缺安装来源（npm 或 local）` };
  const strings = (v: unknown): string[] | undefined =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : undefined;
  return {
    entry: {
      id,
      name,
      version,
      enginesDing,
      ...(npm ? { npm } : {}),
      ...(local ? { local } : {}),
      ...(typeof e.description === "string" ? { description: e.description } : {}),
      ...(typeof e.publisher === "string" ? { publisher: e.publisher } : {}),
      ...(typeof e.homepage === "string" ? { homepage: e.homepage } : {}),
      ...(strings(e.tags) ? { tags: strings(e.tags)! } : {}),
    },
  };
}

/**
 * 解析索引 JSON。
 *
 * @param raw 已 JSON.parse 的内容（不可信）
 * @returns 索引 + 被跳过的条目原因
 */
export function parsePluginIndex(raw: unknown): PluginIndexParse {
  if (!raw || typeof raw !== "object") return { ok: false, errors: ["索引不是对象"] };
  const o = raw as Record<string, unknown>;
  if (o.format !== PLUGIN_INDEX_FORMAT) {
    return { ok: false, errors: [`只认 format ${PLUGIN_INDEX_FORMAT}（这份是 ${String(o.format)}）`] };
  }
  if (!Array.isArray(o.plugins)) return { ok: false, errors: ["plugins 必须是数组"] };
  const problems: string[] = [];
  const plugins: PluginIndexEntry[] = [];
  const seen = new Set<string>();
  for (const item of o.plugins) {
    const { entry, problem } = normalizeEntry(item);
    if (!entry) {
      if (problem) problems.push(problem);
      continue;
    }
    if (seen.has(entry.id)) {
      problems.push(`${entry.id}：id 重复（后面的跳过）`);
      continue;
    }
    seen.add(entry.id);
    plugins.push(entry);
  }
  return {
    ok: true,
    index: {
      format: PLUGIN_INDEX_FORMAT,
      ...(typeof o.updatedAt === "string" ? { updatedAt: o.updatedAt } : {}),
      plugins,
    },
    problems,
  };
}

/** 一条搜索命中。 */
export type PluginSearchHit = PluginIndexEntry & {
  /** 这个词于本宿主版本是否兼容（不兼容的条目仍然列出来）。 */
  compatible: boolean;
  /** 不兼容的原因（兼容时没有）。 */
  incompatibility?: string;
  score: number;
};

/**
 * 模糊/多语言搜索。
 *
 * 中文按**子串**命中（没有分词器，不假装有）；英文按小写词命中。
 * 命中面：id / name / tags / description / publisher。排序：相关度 → 名字。
 *
 * @param index 索引
 * @param query 查询（空 = 全部，按名字排序）
 * @param hostVersion 宿主版本
 * @returns 命中（含兼容标记）
 */
export function searchPluginIndex(index: PluginIndex, query: string, hostVersion: string): PluginSearchHit[] {
  const q = String(query ?? "").trim().toLowerCase();
  const terms = q ? q.split(/\s+/).filter(Boolean) : [];
  const hits: PluginSearchHit[] = [];
  for (const plugin of index.plugins) {
    const compatible = satisfiesEngines(plugin.enginesDing, hostVersion);
    const fields = {
      id: plugin.id.toLowerCase(),
      name: plugin.name.toLowerCase(),
      tags: (plugin.tags ?? []).map((t) => t.toLowerCase()),
      description: (plugin.description ?? "").toLowerCase(),
      publisher: (plugin.publisher ?? "").toLowerCase(),
    };
    let score = 0;
    if (q) {
      for (const term of terms) {
        if (fields.id === term || fields.name === term) score += 100;
        else if (fields.id.includes(term) || fields.name.includes(term)) score += 20;
        else if (fields.tags.some((t) => t === term)) score += 15;
        else if (fields.tags.some((t) => t.includes(term))) score += 8;
        else if (fields.description.includes(term) || fields.publisher.includes(term)) score += 5;
      }
      if (score === 0) continue;
    }
    hits.push({
      ...plugin,
      compatible,
      ...(compatible ? {} : { incompatibility: `需要 ding ${plugin.enginesDing}，当前 ${hostVersion}` }),
      /* 兼容的排前面（不兼容的仍然可见，但要沉下去） */
      score: score + (compatible ? 1000 : 0),
    });
  }
  return hits.sort((a, b) => (b.score === a.score ? a.name.localeCompare(b.name) : b.score - a.score));
}

/**
 * 安装前的兼容门。
 *
 * @param enginesDing manifest 里的范围
 * @param hostVersion 宿主版本
 * @returns 兼容返回 null；不兼容返回一句能直接展示的话
 */
export function engineIncompatibility(enginesDing: string, hostVersion: string): string | null {
  if (satisfiesEngines(enginesDing, hostVersion)) return null;
  return `这个插件要求 ding ${enginesDing}，当前是 ${hostVersion} —— 装上也跑不起来，先升级或找兼容版本`;
}
