import fs from "node:fs";
import os from "node:os";
import path from "node:path";

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
 * 按优先级列出要读的凭据文件（高优先级在前）。
 *
 * 覆盖变量：`DING_CREDENTIALS_FILE` > `DSH_CREDENTIALS_FILE`（旧名，继续认）。
 * 给了覆盖就只读那一个文件 —— 换机器/测试都要能完全脱离用户目录。
 */
export function credentialsPaths(): string[] {
  const override =
    process.env.DING_CREDENTIALS_FILE?.trim() || process.env.DSH_CREDENTIALS_FILE?.trim();
  if (override) return [override];
  const primary = primaryCredentialsPath();
  const legacy = legacyCredentialsPath();
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
 * 让凭据缓存失效。
 *
 * ⚠️ **写完凭据必须调它**（向导那条路）：否则"刚写完、紧接着读"会在 30 秒内
 * 拿到写之前的快照 —— 表现是"向导说配好了，自检却说没有 key"。
 * 缓存是给"每次发请求读一次盘"省开销的，不是给"写完还读旧的"用的。
 */
export function invalidateCredentialCache(): void {
  cache = null;
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
  const fromEnv = process.env[envName];
  if (fromEnv && fromEnv.trim()) return fromEnv.trim();
  const fromFile = readCredentialRefs()[envName];
  if (fromFile && fromFile.trim()) return fromFile.trim();
  /*
   * 第三段：**桌面加密库**（safeStorage / DPAPI / Keychain）。
   *
   * 2026-10-16 补：用户能在设置里填 key 之后，存进去的那条必须能被读回来 ——
   * 否则「存了还是说没密钥」。没注册目录（CLI / 测试）时它返回 null，行为与以前一样。
   */
  try {
    const mod = require("../adapters/secretStore") as {
      revealSecretFromStore?: (name: string) => string | null;
    };
    const fromStore = mod.revealSecretFromStore?.(envName);
    if (fromStore) return fromStore;
  } catch {
    /* 引擎不该因为读不到加密库而炸 */
  }
  return null;
}

/** 该 key 是否可用（不返回明文）。 */
export function hasSecret(envName: string): boolean {
  return resolveSecret(envName) !== null;
}
