import { app, safeStorage } from "electron";

import {
  cipherName,
  deleteSecret,
  registerSecretCipher,
  registerSecretDir,
  secretsEncrypted,
  writeSecret,
} from "../../engine/adapters/secretStore";
import { removeSecretFromPrimary } from "../../hosts/cli/wizard";

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
  adoptEnv: "secrets:adoptEnv",
  remove: "secrets:remove",
} as const;

/** 注册这三个通道。 */
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
  /*
   * M-02：把环境变量里已有的那条 key **抄进本应用**。
   *
   * 值只在主进程里走一趟（渲染层从头到尾看不到明文）。保存后环境变量仍然优先
   * （`resolveSecret` 的顺序没变）—— 所以界面上要如实说"存下了，但环境变量还在时仍用它自己的"。
   */
  ipcMainInstance.handle(
    SECRETS_CHANNEL.adoptEnv,
    (_event, refName: unknown): { ok: boolean; reason?: string } => {
      if (typeof refName !== "string" || !refName.trim()) return { ok: false, reason: "引用名不能为空" };
      const name = refName.trim();
      const value = process.env[name]?.trim();
      if (!value) return { ok: false, reason: `环境变量里没有 ${name}` };
      const got = writeSecret(app.getPath("userData"), name, value);
      return got.ok ? { ok: true } : { ok: false, reason: got.reason };
    },
  );
  /*
   * M-06：删一条**本应用存的** key（删自定义供应商时级联）。
   *
   * 两个落点都要清：`secrets.dat`（设置里填的）与 `~/.ding/.credentials.yaml`
   * （新供应商表单写的）。**不动** env 与 `~/.dsh` —— 那两个不归我们管，
   * 所以返回里如实列出"清掉了哪些 / 哪些还在外面"。
   */
  ipcMainInstance.handle(
    SECRETS_CHANNEL.remove,
    (_event, refName: unknown): { ok: boolean; removed: string[]; reason?: string } => {
      if (typeof refName !== "string" || !refName.trim()) return { ok: false, removed: [], reason: "引用名不能为空" };
      const name = refName.trim();
      const removed: string[] = [];
      const storeGot = deleteSecret(app.getPath("userData"), name);
      if (!storeGot.ok) return { ok: false, removed, reason: storeGot.reason };
      if (storeGot.removed) removed.push("secrets.dat");
      const yamlGot = removeSecretFromPrimary(name);
      if (!yamlGot.ok) return { ok: false, removed, reason: yamlGot.error };
      if (yamlGot.removed) removed.push("~/.ding/.credentials.yaml");
      return { ok: true, removed };
    },
  );
}
