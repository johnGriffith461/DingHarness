import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { KeySource } from "../ports/secret";

/**
 * 凭据读取（只读，绝不回传明文给渲染进程）。
 *
 * 优先级：环境变量 → `~/.ding/.credentials.yaml`（Ding 自己的）→
 * `~/.dsh/.credentials.yaml`（**旧位置，只读兜底**）。
 * 渲染进程只能拿到"某个 provider 有没有可用 key"这种布尔信息与一份脱敏的模型清单，
 * key 本体只在主进程里用来发请求。
 *
 * ## 为什么从 `~/.dsh` 搬到 `~/.ding`（2026-10-19）
 *
 * `~/.dsh` 这个名字会被误读成 "DeepSeek Harness"，而它**不是我们的目录** ——
 * 同一层里还有别的程序写的东西（`~/.dsh/.workbuddy-*.json`、`.agent-presets/`），
 * 所以「把目录改名」不是我们有权做的事。能做的是**把 Ding 自己的文件搬走**：
 * Ding 只往 `~/.ding/.credentials.yaml` 写，旧文件仍然读得到（老用户的 key 不会失效）。
 */

/** 新位置：Ding 自己的数据目录（CLI 的 `--data-dir` 默认也是它）。 */
const PRIMARY_DIRNAME = ".ding";
/**
 * 旧位置：与别的程序共用的目录。
 * ⚠️ 只读、不写、不删 —— 那个文件可能是另一个程序（用户的启动器）的资产。
 */
const LEGACY_DIRNAME = ".dsh";
const CREDENTIALS_FILENAME = ".credentials.yaml";

/** Ding 自己的凭据文件（写入口）。 */
export function primaryCredentialsPath(): string {
  return path.join(os.homedir(), PRIMARY_DIRNAME, CREDENTIALS_FILENAME);
}

/** 旧位置（只读兜底）。 */
export function legacyCredentialsPath(): string {
  return path.join(os.homedir(), LEGACY_DIRNAME, CREDENTIALS_FILENAME);
}

/**
 * 一条 key 的**来源**（M-02）—— 类型在端口层（见 `ports/secret.ts` 的说明），
 * 这里 re-export 保持既有 import 不变。
 *
 * `"app"` 是我们自己的两个落点（`~/.ding` 的凭据文件 / 桌面加密库）；
 * `"legacy"` 专指 `~/.dsh` —— 那个目录别的程序也在用，里面的 key **不能被算成**
 * "用户在本应用里配过了"（主人报的第 1 条正是这个）。
 */
export type { KeySource } from "../ports/secret";

/**
 * 按优先级列出要读的凭据文件（高优先级在前）。
 *
 * 覆盖变量：
 * - `DING_CREDENTIALS_FILE` > `DSH_CREDENTIALS_FILE`（旧名，继续认）—— **主位置**；
 *   给了它且没有单独给旧位置时，只读那一个文件（换机器/测试要能完全脱离用户目录）。
 * - `DING_LEGACY_CREDENTIALS_FILE` —— **只**换"旧位置"那一格（默认 `~/.dsh`）。
 *   这条是给验收用的：不然要构造"旧目录里有 key、本应用里没有"就得改家目录，
 *   而改 `USERPROFILE` 会让 Electron 起不来（2026-10-21 实测）。
 */
export function credentialsPaths(): string[] {
  const primaryOverride =
    process.env.DING_CREDENTIALS_FILE?.trim() || process.env.DSH_CREDENTIALS_FILE?.trim();
  const legacyOverride = process.env.DING_LEGACY_CREDENTIALS_FILE?.trim();

  if (primaryOverride) {
    return legacyOverride && legacyOverride !== primaryOverride ? [primaryOverride, legacyOverride] : [primaryOverride];
  }
  const primary = primaryCredentialsPath();
  const legacy = legacyOverride || legacyCredentialsPath();
  return primary === legacy ? [primary] : [primary, legacy];
}

/**
 * **写**入口：永远是新的那个位置。
 *
 * 写入不再落到旧文件上：那份文件可能被别的程序共用，我们只该管自己那一份。
 * 读的时候会把两边合起来（见 `readCredentialRefs`），所以老用户的 key 照旧能用。
 */
export function credentialsPath(): string {
  return credentialsPaths()[0]!;
}

/**
 * 极简 YAML 读取：只需要支持 `refs:` 下一层的 `KEY: value`。
 * 不引 yaml 依赖 —— 文件格式由另一个程序写死，结构固定。
 */
function parseRefs(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  const lines = text.split(/\r?\n/);
  let inRefs = false;
  let refsIndent = -1;

  for (const raw of lines) {
    if (!raw.trim() || raw.trimStart().startsWith("#")) continue;
    const indent = raw.length - raw.trimStart().length;
    const line = raw.trim();

    if (/^refs:\s*$/.test(line)) {
      inRefs = true;
      refsIndent = indent;
      continue;
    }
    if (!inRefs) continue;
    // 回到同级或更外层，说明 refs 段结束
    if (indent <= refsIndent) break;

    const match = /^([A-Za-z0-9_]+)\s*:\s*(.*)$/.exec(line);
    if (!match) continue;
    let value = match[2].trim();
    if (!value) continue;
    // 去掉可能的引号
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out[match[1]] = value;
  }

  return out;
}

/**
 * 缓存。
 *
 * ⚠️ **必须按文件路径分开**（2026-10-15 修）：原来只记时间戳，于是换了凭据文件
 * （覆盖变量变过、或者用户在向导里刚写完一份新的）之后，
 * 30 秒内读到的还是**上一个文件**的内容 —— 表现是"刚配好，doctor 却说没配"。
 * 这条是 `hosts/cli/wizard.test.ts` 逮到的：它每个用例换一个凭据文件。
 */
let cache: { at: number; files: string; refs: Record<string, string> } | null = null;

/**
 * 单文件缓存（`keySourceOf` 要区分"这条 key 来自哪一份文件"）。
 *
 * `readCredentialRefs` 只给合并后的结果，用来判断"有没有"够了，但**判断不了来源**。
 * 这里按文件各缓存一份：读还是走同一个 `parseRefs`，不另写一套解析。
 */
const fileCache = new Map<string, { at: number; stat: string; refs: Record<string, string> }>();

/** 读**一份**凭据文件的 refs（30s 缓存；文件大小/修改时间变了立刻重读）。 */
function readRefsFromFile(file: string): Record<string, string> {
  const now = Date.now();
  let stat = "";
  try {
    const s = fs.statSync(file);
    stat = `${s.size}:${s.mtimeMs}`;
  } catch {
    return {};
  }
  const hit = fileCache.get(file);
  if (hit && hit.stat === stat && now - hit.at < 30_000) return hit.refs;
  try {
    const text = fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "");
    const refs = parseRefs(text);
    fileCache.set(file, { at: now, stat, refs });
    return refs;
  } catch {
    return {};
  }
}

/**
 * **这条 key 从哪来**（诚实来源，不把别人的文件算成"你配过了"）。
 *
 * 顺序与 `resolveSecret` 完全一致：环境变量 → 本应用的凭据文件（`~/.ding`）→
 * 旧位置（`~/.dsh`，只读兜底）→ 桌面加密库（`secrets.dat`）。
 *
 * 口径：
 * - `"app"`    —— 我们自己的（`~/.ding/.credentials.yaml` 或 `secrets.dat`）；
 * - `"env"`    —— 只来自环境变量；
 * - `"legacy"` —— 只来自 `~/.dsh`（别的程序/旧版本留下的，不是用户在本应用里配的）；
 * - `"none"`   —— 哪都没有。
 *
 * @param ref 凭据引用名（provider 表里的 `keyRef`）
 */
export function keySourceOf(ref: string): KeySource {
  const name = String(ref ?? "").trim();
  if (!name) return "none";
  if (process.env[name]?.trim()) return "env";

  const files = credentialsPaths();
  const primary = files[0];
  const legacy = files[1];
  if (primary && readRefsFromFile(primary)[name]?.trim()) return "app";

  /*
   * **本应用保存的优先于旧目录**（M-02）：用户在设置里显式存过一条，
   * 就该是他在用那条 —— 而不是被 `~/.dsh` 里别的程序写的旧值盖住。
   * 这条顺序与 `resolveSecret` 完全一致，否则界面说的来源会是假的。
   */
  try {
    const mod = require("../adapters/secretStore") as {
      revealSecretFromStore?: (name: string) => string | null;
    };
    const fromStore = mod.revealSecretFromStore?.(name);
    if (fromStore && fromStore.trim()) return "app";
  } catch {
    /* 读不到加密库 = 这一站没有，不改变结论 */
  }

  /* 覆盖变量只给一个文件时，那份就是"我们自己的"（测试/便携模式显式指定的） */
  if (legacy && legacy !== primary && readRefsFromFile(legacy)[name]?.trim()) return "legacy";
  return "none";
}

/**
 * 让凭据缓存失效。
 *
 * ⚠️ **写完凭据必须调它**（向导那条路）：否则"刚写完、紧接着读"会在 30 秒内
 * 拿到写之前的快照 —— 表现是"向导说配好了，自检却说没有 key"。
 * 缓存是给"每次发请求读一次盘"省开销的，不是给"写完还读旧的"用的。
 */
export function invalidateCredentialCache(): void {
  cache = null;
  fileCache.clear();
}

/**
 * 读 refs 段（带 30s 缓存，避免每次发请求都读盘）。
 *
 * **两个文件会合并**（2026-10-19）：`~/.ding/` 里的优先，`~/.dsh/` 里的兜底。
 * 合并是逐键的 —— 所以「新位置只写了一部分、老的还有别的键」也不会互相打架；
 * 同一个键出现两次时，新的那份赢（用户自己的意愿优先于历史/别人的文件）。
 *
 * 缓存键是**整组路径 + 时间**：换了文件立刻失效（不清缓存就读到别人的 key 才是更坏的）。
 */
export function readCredentialRefs(): Record<string, string> {
  const now = Date.now();
  const files = credentialsPaths();
  const cacheKey = files.join("|");
  if (cache && cache.files === cacheKey && now - cache.at < 30_000) return cache.refs;

  const refs: Record<string, string> = {};
  /*
   * 反向遍历：先读低优先级的（旧文件），再用高优先级的覆盖。
   * 顺序写反会让"新文件里的 key 被旧文件盖掉" —— 那正是这次搬家要避免的事。
   */
  for (const file of [...files].reverse()) {
    try {
      if (!fs.existsSync(file)) continue;
      // 先按 UTF-8 解，失败再退到 latin1（BOM/编码异常时至少不崩）
      const text = fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "");
      Object.assign(refs, parseRefs(text));
    } catch {
      /* 单个文件读不了就跳过：另一个文件里可能还有能用的 key */
    }
  }

  cache = { at: now, files: cacheKey, refs };
  return refs;
}

/**
 * 取某个 key 的实际值。
 * @param envName 环境变量名 / 凭据引用名
 * @returns 明文密钥；没有则 null
 */
export function resolveSecret(envName: string): string | null {
  const name = String(envName ?? "").trim();
  if (!name) return null;
  const fromEnv = process.env[name];
  if (fromEnv && fromEnv.trim()) return fromEnv.trim();

  /*
   * 顺序（M-02 修正）：本应用主文件 → **本应用加密库** → 旧目录。
   *
   * 原来的顺序是「合并文件（主+旧）→ 加密库」—— 于是用户在设置里存了一条，
   * 旧目录里那条仍会赢，界面只能如实说"来自旧目录"（保存了却不算数）。
   * 现在用户**显式保存**的那条优先于 `~/.dsh`；旧目录只剩"兜底"这一层。
   */
  const files = credentialsPaths();
  const primary = files[0];
  const legacy = files[1];
  const fromPrimary = primary ? readRefsFromFile(primary)[name] : undefined;
  if (fromPrimary && fromPrimary.trim()) return fromPrimary.trim();

  try {
    const mod = require("../adapters/secretStore") as {
      revealSecretFromStore?: (name: string) => string | null;
    };
    const fromStore = mod.revealSecretFromStore?.(name);
    if (fromStore && fromStore.trim()) return fromStore.trim();
  } catch {
    /* 引擎不该因为读不到加密库而炸 */
  }

  const fromLegacy = legacy && legacy !== primary ? readRefsFromFile(legacy)[name] : undefined;
  if (fromLegacy && fromLegacy.trim()) return fromLegacy.trim();
  return null;
}

/** 该 key 是否可用（不返回明文）。 */
export function hasSecret(envName: string): boolean {
  return resolveSecret(envName) !== null;
}
