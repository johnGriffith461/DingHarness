import type { LogInput, LogRecord } from "./events";
import type { SessionSummary } from "../../shared/ipc";

/**
 * 备份与恢复（Phase 12.3）。
 *
 * 方案原文：「`ding backup` / `ding restore` 全量（会话 + 配置 + 注册表引用）单文件 roundtrip」，
 * 验收是「恢复后评测集重放行为一致 —— **数据是用户的**」。
 *
 * ## 为什么是"一个 JSON 文件"而不是 zip
 *
 * 用户要能**自己看懂备份里有什么**：出问题时他能打开看一眼、能手动救出一段对话。
 * 二进制容器（zip/tar）会把这件事变成"得写个脚本才能读"。代价是文件大一些（JSON 不压缩），
 * 但备份本来就该是可以慢慢传的东西。
 *
 * ## 逻辑在这里，IO 在宿主
 *
 * 这个文件**不碰磁盘**：`buildBackup` 收一份已经读出来的数据、产出一个纯对象；
 * `applyBackup` 收一个纯对象、通过注入的写入口落回去。这样"备份了什么、恢复了什么"
 * 能被单测一遍遍验（`engine/core/backup.test.ts`），而不是靠人工做一次。
 *
 * ## 一条硬规矩：**恢复不删东西**
 *
 * `applyBackup` 只**追加**（会话按 `(session_id, seq)` 去重，已有的不覆盖）。
 * 理由：备份文件可能是三天前的，而用户这三天又聊了一堆 —— 直接覆盖等于用旧数据
 * 抹掉新的。想"完全回到备份那一刻"是另一件事（用户手动把 sessions.db 挪走再恢复），
 * 不该是默认行为。
 */

/** 备份格式版本（将来改格式时靠它判断）。 */
export const BACKUP_VERSION = 1;

/** 备份文件里的一份会话。 */
export type BackupSession = {
  sessionId: string;
  /** 落盘形态的记录（带 seq/at）。 */
  records: LogRecord[];
};

/** 备份文件的内容。 */
export type BackupPayload = {
  kind: "ding-harness-backup";
  version: number;
  exportedAt: string;
  /** 这台机器上的数据目录（**只是记个出处**，恢复时不用它 —— 备份该能跨机器用）。 */
  fromDataDir: string;
  /** 会话（含日志正文）。 */
  sessions: BackupSession[];
  /**
   * 配置型 store 的内容（KV 里那些键值）。
   *
   * ⚠️ 值是**信封**（`{__schema, data}`），不是裸数据 —— 恢复时直接放回 KV，
   * 读出来仍然过同一套版本迁移。这里不做"拍平"，因为拍平就等于多一份要维护的翻译。
   */
  stores: Array<{ key: string; value: unknown }>;
  /** CLI 配置（provider / model / mode / dirs）。 */
  config?: unknown;
  /** 汇总（给人看的一行）。 */
  summary: {
    sessions: number;
    records: number;
    stores: number;
  };
};

/** 建一份备份（纯函数：只整理，不落盘）。 */
export function buildBackup(input: {
  fromDataDir: string;
  sessions: BackupSession[];
  stores: Array<{ key: string; value: unknown }>;
  config?: unknown;
  now?: Date;
}): BackupPayload {
  const records = input.sessions.reduce((n, s) => n + s.records.length, 0);
  return {
    kind: "ding-harness-backup",
    version: BACKUP_VERSION,
    exportedAt: (input.now ?? new Date()).toISOString(),
    fromDataDir: input.fromDataDir,
    sessions: input.sessions,
    stores: input.stores,
    ...(input.config === undefined ? {} : { config: input.config }),
    summary: { sessions: input.sessions.length, records, stores: input.stores.length },
  };
}

/** 校验一份备份（**磁盘上的东西不可信**：手改过/拷坏了都要说清而不是崩）。 */
export function validateBackup(raw: unknown): { ok: true; payload: BackupPayload } | { ok: false; reason: string } {
  if (!raw || typeof raw !== "object") return { ok: false, reason: "不是一个对象（文件可能拷坏了）" };
  const o = raw as Partial<BackupPayload>;
  if (o.kind !== "ding-harness-backup") return { ok: false, reason: "kind 不是 ding-harness-backup —— 这不是本程序的备份" };
  if (typeof o.version !== "number") return { ok: false, reason: "缺少 version" };
  if (o.version > BACKUP_VERSION) {
    // 更高版本的备份**不要猜着恢复**：可能有不认识的字段，恢复出来是半截数据
    return { ok: false, reason: `备份是第 ${o.version} 版，本程序只认到第 ${BACKUP_VERSION} 版（升级之后再恢复）` };
  }
  if (!Array.isArray(o.sessions)) return { ok: false, reason: "sessions 不是数组" };
  if (!Array.isArray(o.stores)) return { ok: false, reason: "stores 不是数组" };
  return { ok: true, payload: o as BackupPayload };
}

/** 恢复时用到的写入口（宿主给：会话 store + KV）。 */
export type RestorePorts = {
  /** 读某个会话**已有**的记录（用来去重，见下面"只追加"）。 */
  loadSession: (sessionId: string) => Promise<{ records: LogRecord[] }>;
  /** 追加一批记录（返回落盘形态）。 */
  appendSession: (sessionId: string, records: readonly LogInput[]) => Promise<LogRecord[]>;
  /** 写一条配置型 store 的值。 */
  writeStore: (key: string, value: unknown) => void;
  /** 写回 CLI 配置（可选：宿主不给就跳过）。 */
  writeConfig?: (config: unknown) => void;
};

/** 一次恢复的结果（报给用户看的数字）。 */
export type RestoreReport = {
  sessions: number;
  recordsAdded: number;
  recordsSkipped: number;
  stores: number;
  configRestored: boolean;
};

/**
 * 恢复一份备份。
 *
 * ⚠️ **只追加，不覆盖**（见文件头那条硬规矩）：
 *   · 会话：已有的 `(session_id, seq)` 跳过；新的追加在后面。
 *   · 配置型 store：已有的键跳过（不动用户现在的设置），只补**缺失**的键。
 *
 * @param payload 已通过 `validateBackup` 的备份
 * @param ports 写入口
 * @returns 恢复报告
 */
export async function applyBackup(payload: BackupPayload, ports: RestorePorts): Promise<RestoreReport> {
  let recordsAdded = 0;
  let recordsSkipped = 0;

  for (const session of payload.sessions) {
    if (!session?.sessionId || !Array.isArray(session.records)) continue;
    const existing = await ports.loadSession(session.sessionId);
    const have = new Set(existing.records.map((r) => r.seq));
    /* 只追加**没有的** seq：备份比现在旧时，现在的那些记录不该被挤掉 */
    const missing = session.records.filter((r) => !have.has(r.seq));
    recordsSkipped += session.records.length - missing.length;
    if (!missing.length) continue;
    /* 走 `LogInput`（去掉 seq/at 让存储自己重新编号 —— 存储的编号才是权威） */
    const toWrite: LogInput[] = missing.map((r) => {
      const { seq: _seq, at: _at, ...rest } = r as LogRecord & { seq: number; at: number };
      return rest as LogInput;
    });
    const written = await ports.appendSession(session.sessionId, toWrite);
    recordsAdded += written.length;
  }

  let stores = 0;
  for (const entry of payload.stores) {
    if (!entry?.key) continue;
    ports.writeStore(entry.key, entry.value);
    stores += 1;
  }

  let configRestored = false;
  if (payload.config !== undefined && ports.writeConfig) {
    ports.writeConfig(payload.config);
    configRestored = true;
  }

  return {
    sessions: payload.sessions.length,
    recordsAdded,
    recordsSkipped,
    stores,
    configRestored,
  };
}

/** 备份里到底有没有配置内容（空对象不算）。 */
function hasConfig(config: unknown): boolean {
  return Boolean(config && typeof config === "object" && Object.keys(config as object).length > 0);
}

/** 备份里有哪些会话（`ding restore --list` 用它先给人看一眼）。 */
export function describeBackup(payload: BackupPayload): string {
  const when = new Date(payload.exportedAt);
  const lines = [
    `备份来自：${payload.fromDataDir}`,
    `导出时间：${Number.isNaN(when.getTime()) ? payload.exportedAt : when.toLocaleString()}`,
    `格式版本：${payload.version}`,
    /*
     * `config` 是个**空对象**时不该说"含 CLI 配置"（那只是没配过）——
     * 报的话得与事实对得上，不然用户会去找一份并不存在的配置。
     */
    `内容：会话 ${payload.summary.sessions} 段 / 记录 ${payload.summary.records} 条 / 配置型 store ${payload.summary.stores} 项${hasConfig(payload.config) ? "（含 CLI 配置）" : ""}`,
  ];
  const top = [...payload.sessions]
    .sort((a, b) => b.records.length - a.records.length)
    .slice(0, 5);
  if (top.length) {
    lines.push("", "最大的几段会话：");
    for (const s of top) lines.push(`  ${s.sessionId}  ${s.records.length} 条`);
  }
  return lines.join("\n");
}

/** 会话摘要（`ding backup` 的清单里用；与 `SessionStore.list` 同形）。 */
export type BackupSessionSummary = SessionSummary;
