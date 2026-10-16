import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * 密钥的**加密存储**（Phase 14.2）。
 *
 * 方案原文：「密钥入系统钥匙串（Win Credential Manager / macOS Keychain /
 * Linux secret-service），不明文落盘；旧明文配置一次性迁移并提示」。
 *
 * ## 这里怎么落地的（以及**为什么不是别的样子**）
 *
 * 分两种密钥，处置不同 —— 这个区分很重要，混在一起会做错事：
 *
 * | 谁的密钥 | 现状 | 为什么 |
 * |---|---|---|
 * | **我们写的**（`ding init` 向导、桌面里填的 provider key） | 进 `secrets.dat`，**加密**（见下） | 这是我们自己的数据，没有理由明文 |
 * | **别人写的**（`~/.dsh/.credentials.yaml`） | 只读，**不动它** | 那个文件是另一个程序（用户的启动器）的资产，加密它等于把人家的文件改坏 |
 *
 * ## 加密用什么
 *
 * - **Electron 里**（桌面）：`safeStorage` —— Windows 走 DPAPI、macOS 走 Keychain、
 *   Linux 走 libsecret。这就是"系统钥匙串"那条要求的落点（Electron 把它封了一层）。
 * - **CLI / Bun 单二进制里**：没有 `safeStorage`，所以那时 `available()` 返回 false，
 *   并且**如实说明**"这台机器上 CLI 存的密钥没有加密"（`ding doctor` 的「凭据保护」那一格）。
 *   宁可说清，也不要假装加密了。
 *
 * ⚠️ 加密是**本机绑定**的（DPAPI/Keychain 都按用户加密）：换了机器或换了用户，
 * `secrets.dat` 解不开。所以备份里**不含它**（见 `engine/core/backup.ts`），
 * 换机器要重新填一次 key —— 这是刻意的取舍，不是遗漏。
 */

/** 我们自己的密钥文件名（放在 CLI 的数据目录里，与配置文件同级）。 */
export const SECRETS_FILE = "secrets.dat";

/** 加密能力（宿主注入：桌面给 safeStorage，CLI 给 null）。 */
export type SecretCipher = {
  /** 名字（写进 doctor 的说明里，让用户知道是哪一层在保护）。 */
  name: string;
  /** 能不能加密（Electron 的 safeStorage 在某些 Linux 上没有后端，会返回 false）。 */
  available: () => boolean;
  encrypt: (plain: string) => Buffer;
  decrypt: (blob: Buffer) => string;
};

let cipher: SecretCipher | null = null;

/**
 * 注册加密实现（宿主在启动时调一次）。
 *
 * 桌面：`registerSecretCipher(safeStorageCipher(safeStorage))`；
 * CLI：不注册 —— 于是 CLI 下 `available()` 为 false，doctor 会如实说"没有加密"。
 */
export function registerSecretCipher(next: SecretCipher | null): void {
  cipher = next;
}

/** 当前有没有加密能力（没有时**别假装有**）。 */
export function secretsEncrypted(): boolean {
  try {
    return Boolean(cipher?.available());
  } catch {
    return false;
  }
}

/** 当前用的哪一层（给人看的名字）。 */
export function cipherName(): string {
  return cipher?.name ?? "（没有：这台机器上 CLI 存的密钥是明文）";
}

function secretsPath(dir: string): string {
  return path.join(dir, SECRETS_FILE);
}

/** 读全部（解不开就**当没有** —— 换了机器/用户时表现为"要重新填一次 key"，而不是崩）。 */
export function readSecrets(dir: string): Record<string, string> {
  const file = secretsPath(dir);
  if (!existsSync(file) || !secretsEncrypted()) return {};
  try {
    const blob = readFileSync(file);
    const text = cipher!.decrypt(blob);
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === "string") out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

/** 写一条（**没有加密能力时拒绝写**：见下面"为什么不退化成明文"）。 */
export function writeSecret(
  dir: string,
  refName: string,
  value: string,
): { ok: true } | { ok: false; reason: string } {
  if (!secretsEncrypted()) {
    /*
     * ⭐ **不退化写明文**是刻意的：
     * "我们以为是加密的、其实是明文"是最坏的一种 —— 用户会把 key 交给我们，
     * 而它落在磁盘上没有保护，且**看起来**已经保护好了（有个 secrets.dat）。
     * 宁可写失败并说清"这台机器上配不了安全存储"。
     */
    return {
      ok: false,
      reason: `这台机器上拿不到系统密钥保护（${cipherName()}）—— 不写明文。可以改用环境变量，或用桌面端填 key`,
    };
  }
  try {
    mkdirSync(dir, { recursive: true });
    const all = { ...readSecrets(dir), [refName]: value };
    writeFileSync(secretsPath(dir), cipher!.encrypt(JSON.stringify(all)), { mode: 0o600 });
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: (error as Error)?.message ?? "写不进去" };
  }
}

/**
 * 凭据保护状态（`ding doctor` 的「凭据保护」那一格）。
 *
 * 说清三件事：我们的密钥有没有加密、用的哪一层、那个**别人的**明文文件在不在。
 */
export function credentialProtection(dir: string): { detail: string; next: string } {
  const ours = existsSync(secretsPath(dir));
  const protectedNow = secretsEncrypted();
  const legacy = path.join(os.homedir(), ".dsh", ".credentials.yaml");
  const legacyExists = existsSync(legacy);

  const parts: string[] = [];
  parts.push(
    !ours
      ? "我们自己的密钥：还没有存过"
      : protectedNow
        ? `我们自己的密钥：已加密（${cipherName()}）`
        : `我们自己的密钥：**没有加密**（${cipherName()}）`,
  );
  if (legacyExists) {
    parts.push(
      `${legacy}：明文（那是**另一个程序的文件**，我们只读不改 —— 加密它等于把人家的文件改坏）`,
    );
  }

  const next = !protectedNow
    ? "想让我们的密钥走系统保护：在桌面端填一次 provider key（它用系统密钥串加密）"
    : legacyExists
      ? "那个明文文件是别家的：要减少明文面，可以让写它的程序也加密，或者换成设环境变量"
      : "无需处理";

  return { detail: parts.join("；"), next };
}

/**
 * 桌面的**密钥目录**（2026-10-16）。
 *
 * 为什么要有它：writeSecret(dir, …) 一直带 dir，而「读」这条路从来没接过 ——
 * 于是设置里存进去的 key 运行时读不到（表现是：存了还是说没密钥）。
 * 宿主（桌面）在建窗口时把它注册进来，resolveSecret 就能把加密库当成最后一站。
 */
let secretDir = "";

/** 注册密钥目录（桌面：app.getPath("userData")）。 */
export function registerSecretDir(dir: string): void {
  secretDir = dir;
}

/**
 * 从加密库里取一条（读不到 / 解不开 / 没注册目录 → null：调用方继续用前面的来源）。
 *
 * @param refName 引用名（与 keyRef 同名，例如 DEEPSEEK_API_KEY）
 */
export function revealSecretFromStore(refName: string): string | null {
  if (!secretDir) return null;
  try {
    const got = readSecrets(secretDir)[refName] ?? null;
    return got && got.trim() ? got.trim() : null;
  } catch {
    return null;
  }
}
