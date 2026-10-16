import { app, safeStorage } from "electron";

import { cipherName, registerSecretCipher, registerSecretDir, secretsEncrypted, writeSecret } from "../../engine/adapters/secretStore";

/**
 * 桌面侧的密钥保护（Phase 14.2）——把 Electron 的 `safeStorage` 接进那个端口。
 *
 * ## 为什么是 safeStorage
 *
 * 它就是"系统钥匙串"那条要求在 Electron 里的入口：
 * Windows 走 **DPAPI**（按当前用户加密）、macOS 走 **Keychain**、Linux 走 **libsecret**。
 * 自己接 Win32/Cocoa 的 API 只会多一份要维护的平台代码，而语义完全一样。
 *
 * ## 两条如实说明
 *
 * 1. `safeStorage.isEncryptionAvailable()` **可能是 false**（比如 Linux 上没有
 *    secret-service 后端）。那时 `secretStore` 会**拒绝写**而不是退化成明文 ——
 *    "以为加密了其实是明文"是最坏的一种。
 * 2. 加密是**本机绑定**的：换了机器或换了用户，那些 blob 解不开。
 *    所以备份里不含它，换机器要重新填一次 key（见 `engine/core/backup.ts`）。
 */
export function registerDesktopSecretCipher(): void {
  /* 写入与读取必须落在**同一个目录**（secrets.dat 就在这儿） */
  registerSecretDir(app.getPath("userData"));
  registerSecretCipher({
    name: safeStorageName(),
    available: () => {
      try {
        return safeStorage.isEncryptionAvailable();
      } catch {
        return false;
      }
    },
    encrypt: (plain) => safeStorage.encryptString(plain),
    decrypt: (blob) => safeStorage.decryptString(blob),
  });
}

/** 给人看的名字（按平台说清是哪一层的保护）。 */
function safeStorageName(): string {
  if (process.platform === "win32") return "Windows DPAPI（当前用户）";
  if (process.platform === "darwin") return "macOS Keychain";
  return "Linux secret-service";
}

/**
 * `secrets:set` / `secrets:status` 的 IPC（2026-10-16）。
 *
 * 「设置里直接填 key」这条路：用户粘一条 key → 走 `writeSecret`（**加密**写进
 * `secrets.dat`）→ 运行时 `resolveSecret` 的第三段就能读到它。
 *
 * ⚠️ 两条如实说明（与 SAFETY 一致）：
 *   · 拿不到系统加密能力时**拒绝写**（`writeSecret` 自己就这样），这里是**如实回报原因**，
 *     不吞成"成功"；用户会把 key 交给我们，静默降级成明文是最坏的一种；
 *   · 值**不回传**（`status` 只说"能不能加密"，不吐明文）。
 */
export const SECRETS_CHANNEL = {
  status: "secrets:status",
  set: "secrets:set",
} as const;

/** 注册这两个通道。 */
export function registerSecretsIpc(ipcMainInstance: Electron.IpcMain): void {
  ipcMainInstance.handle(SECRETS_CHANNEL.status, () => ({
    encrypted: secretsEncrypted(),
    where: cipherName(),
  }));
  ipcMainInstance.handle(
    SECRETS_CHANNEL.set,
    (_event, refName: unknown, value: unknown): { ok: boolean; reason?: string } => {
      if (typeof refName !== "string" || !refName.trim()) return { ok: false, reason: "引用名不能为空" };
      if (typeof value !== "string" || !value.trim()) return { ok: false, reason: "密钥不能为空" };
      const got = writeSecret(app.getPath("userData"), refName.trim(), value.trim());
      return got.ok ? { ok: true } : { ok: false, reason: got.reason };
    },
  );
}
