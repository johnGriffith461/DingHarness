import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * 凭据读取（只读，绝不回传明文给渲染进程）。
 *
 * 优先级：环境变量 → `~/.dsh/.credentials.yaml`（DSH 的凭据库）。
 * 渲染进程只能拿到"某个 provider 有没有可用 key"这种布尔信息与一份脱敏的模型清单，
 * key 本体只在主进程里用来发请求。
 */

/** 凭据文件位置（可用 DSH_CREDENTIALS_FILE 覆盖，便于换机器）。 */
export function credentialsPath(): string {
  const override = process.env.DSH_CREDENTIALS_FILE;
  if (override) return override;
  return path.join(os.homedir(), ".dsh", ".credentials.yaml");
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

let cache: { at: number; refs: Record<string, string> } | null = null;

/** 读 refs 段（带 30s 缓存，避免每次发请求都读盘）。 */
export function readCredentialRefs(): Record<string, string> {
  const now = Date.now();
  if (cache && now - cache.at < 30_000) return cache.refs;

  let refs: Record<string, string> = {};
  try {
    const file = credentialsPath();
    if (fs.existsSync(file)) {
      // 先按 UTF-8 解，失败再退到 latin1（BOM/编码异常时至少不崩）
      const text = fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "");
      refs = parseRefs(text);
    }
  } catch {
    refs = {};
  }

  cache = { at: now, refs };
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
  return null;
}

/** 该 key 是否可用（不返回明文）。 */
export function hasSecret(envName: string): boolean {
  return resolveSecret(envName) !== null;
}
