import { safeStorage } from "electron";

import { registerSecretCipher } from "../../engine/adapters/secretStore";

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
