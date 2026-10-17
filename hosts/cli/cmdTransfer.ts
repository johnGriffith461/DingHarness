import { createSqliteSessionStore } from "../../engine/adapters/sqliteStore";
import { readConfig, writeConfig, type CliConfig } from "./config";
import { flag, type Parsed } from "./args";

/**
 * `ding export` / `ding import` —— **数据可携带**（L09，2026-10-18）。
 *
 * ## 它解决什么
 *
 * `ding backup` / `ding restore` 搬的是**整个数据目录**（含插件、RAG、KV 库），
 * 适合"整机搬家"；但换一台机器时用户往往只想要**会话与配置**，
 * 而且备份包里带着不该外发的东西。这一对命令做的是**可审阅的 JSON 导出**：
 *
 * - 导出：会话记录（原样）、配置（**去掉自定义 provider 的 baseURL 之外的敏感项**？
 *   不 —— 配置里没有密钥本体，`keyRef` 只是名字，所以整份配置可以带）；
 * - **绝不导出**：`secrets.dat`、`.credentials.yaml`、`computer-use.jsonl`、日志。
 * - 导入：只补**库里没有的会话**（已有的原样保留，不覆盖 —— 覆盖会毁掉导入端的历史）。
 *
 * ## 为什么不是 zip
 *
 * JSON 是用户能打开、能 diff、能自己删几段再导入的格式。备份的完整性由
 * `ding backup` 负责（那是另一个用途）。
 */

/** 导出包的形状（带版本号，便于将来迁移）。 */
export type ExportBundle = {
  kind: "ding-export";
  version: 1;
  exportedAt: number;
  /** 导出时用到的产品版本（排查用）。 */
  product?: string;
  sessions: Array<{
    sessionId: string;
    title?: string;
    forkedFrom?: string;
    records: unknown[];
  }>;
  config?: CliConfig;
};

/**
 * `ding export [--out <文件>] [--kind chat|task|cli]`。
 *
 * @param p 参数
 * @param dataDir 数据目录
 * @param productVersion 产品版本（写进包里）
 */
export async function cmdExport(p: Parsed, dataDir: string, productVersion: string): Promise<number> {
  const store = createSqliteSessionStore(dataDir);
  let sessions: ExportBundle["sessions"] = [];
  try {
    const kind = flag(p, "kind");
    const list = await store.list(
      kind === "chat" || kind === "task" || kind === "cli" ? { kind } : undefined,
    );
    sessions = [];
    for (const summary of list) {
      const { records } = await store.load(summary.sessionId);
      sessions.push({
        sessionId: summary.sessionId,
        ...(summary.title ? { title: summary.title } : {}),
        ...(summary.forkedFrom ? { forkedFrom: summary.forkedFrom } : {}),
        records,
      });
    }
  } finally {
    store.close();
  }
  const bundle: ExportBundle = {
    kind: "ding-export",
    version: 1,
    exportedAt: Date.now(),
    product: productVersion,
    sessions,
    config: readConfig(dataDir).config,
  };
  const out = flag(p, "out") ?? `${dataDir}/export-${new Date().toISOString().slice(0, 10)}.json`;
  const { mkdirSync, writeFileSync } = await import("node:fs");
  const { dirname } = await import("node:path");
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(bundle, null, 2)}\n`, "utf8");
  process.stdout.write(`✓ 导出了 ${sessions.length} 段会话 → ${out}\n`);
  process.stdout.write("包里不含任何密钥（secrets.dat / .credentials.yaml 都不在里面）。\n");
  return 0;
}

/**
 * `ding import <文件> [--dry-run]`。
 *
 * 只补**库里没有的会话**；已有的跳过并计数（不覆盖 —— 覆盖会毁掉导入端的历史）。
 *
 * @param p 参数
 * @param dataDir 数据目录
 */
export async function cmdImport(p: Parsed, dataDir: string): Promise<number> {
  const file = p.args[0];
  if (!file) {
    process.stderr.write("用法：ding import <导出文件.json> [--dry-run]\n");
    return 2;
  }
  const { readFileSync } = await import("node:fs");
  let bundle: ExportBundle;
  try {
    bundle = JSON.parse(readFileSync(file, "utf8")) as ExportBundle;
  } catch (error) {
    process.stderr.write(`读不动这个文件：${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
  if (bundle?.kind !== "ding-export" || !Array.isArray(bundle.sessions)) {
    process.stderr.write("这不是 Ding 的导出文件（缺少 kind=ding-export 或 sessions）。\n");
    return 1;
  }

  const store = createSqliteSessionStore(dataDir);
  try {
    const existing = new Set((await store.list()).map((s) => s.sessionId));
    const fresh = bundle.sessions.filter((s) => s && typeof s.sessionId === "string" && !existing.has(s.sessionId));
    const skipped = bundle.sessions.length - fresh.length;
    if (p.flags.has("dry-run")) {
      process.stdout.write(`会导入 ${fresh.length} 段会话，跳过 ${skipped} 段（已存在）。没有写任何东西。\n`);
      for (const s of fresh.slice(0, 20)) process.stdout.write(`  · ${s.sessionId}\n`);
      return 0;
    }
    let imported = 0;
    for (const session of fresh) {
      const records = session.records.map((record) => record as never);
      await store.append(session.sessionId, records, {
        ...(session.forkedFrom ? { forkedFrom: session.forkedFrom } : {}),
      });
      imported += 1;
    }
    /* 配置：**只在导入端还没有配置时**补上（不覆盖用户已经在用的设置） */
    const current = readConfig(dataDir).config;
    const hasBundleConfig = Boolean(bundle.config && Object.keys(bundle.config).length);
    let configNote = hasBundleConfig ? "（导入端已有配置，未覆盖）" : "（导出包里没有配置）";
    if (Object.keys(current).length === 0 && hasBundleConfig) {
      writeConfig(dataDir, bundle.config!);
      configNote = "（配置也导入了）";
    }
    process.stdout.write(`✓ 导入了 ${imported} 段会话，跳过 ${skipped} 段（已存在）${configNote}\n`);
    return 0;
  } finally {
    store.close();
  }
}
