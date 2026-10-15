import fs from "node:fs";
import path from "node:path";

import { createSqliteSessionStore } from "../../engine/adapters/sqliteStore";
import { kvList, kvWrite } from "../../engine/adapters/kvStore";
import { applyBackup, buildBackup, describeBackup, validateBackup } from "../../engine/core/backup";
import { flag, type Parsed } from "./args";
import { configPaths, readConfig, writeConfig } from "./config";

/**
 * `ding backup` / `ding restore` —— 数据主权（Phase 12.3）。
 *
 * ## 为什么这两条命令重要
 *
 * 方案里这一节的标题是"**日常可靠与数据主权**"。备份不只是容灾：
 * 它意味着"**这些数据是我的**，我可以拿走、可以自己看、可以搬到另一台机器"。
 * 所以备份是**一个能打开的 JSON 文件**（见 `engine/core/backup.ts` 的说明），
 * 而不是一个只有本程序能读的容器。
 *
 * ## 绑三个来源，与 `ding backup --list` 的信息一致
 *
 * | 来源 | 在哪 |
 * |---|---|
 * | 会话日志（含工具留痕、审批、账本） | `sessions.db` 的 events 表 |
 * | 配置型 store（任务 / 记忆 / 定时 / 工作区…） | `stores.db` 的 kv 表 |
 * | CLI 配置（provider / model / 档位 / 目录） | `config.json` |
 *
 * ⚠️ **不含密钥**：凭据在 `~/.dsh/.credentials.yaml`，那是另一个程序的资产，
 * 也**不该**被一个随手分享的备份文件带走。这一条写在这里，免得有人"顺手加上"。
 */

/** 把所有会话读出来（含记录）。 */
async function readAllSessions(storeDir: string) {
  const store = createSqliteSessionStore(storeDir);
  try {
    // 用 `list()` 拿会话清单（它按时间倒序），逐个 `load`
    const summaries = await store.list();
    const sessions: Array<{ sessionId: string; records: Awaited<ReturnType<typeof store.load>>["records"] }> = [];
    for (const s of summaries) {
      const got = await store.load(s.sessionId);
      sessions.push({ sessionId: s.sessionId, records: got.records });
    }
    return sessions;
  } finally {
    store.close();
  }
}

/**
 * `ding backup [--out <文件>]`。
 *
 * 默认写到**当前目录**下一个带时间戳的文件名 —— 备份不该悄悄覆盖上一个。
 */
export async function cmdBackup(p: Parsed, dataDir: string): Promise<number> {
  const sessions = await readAllSessions(dataDir);
  const stores = kvList(dataDir).map((e) => ({ key: e.key, value: e.value }));
  const config = readConfig(dataDir).config;

  const payload = buildBackup({
    fromDataDir: dataDir,
    sessions,
    stores,
    config,
  });

  const out =
    flag(p, "out") ??
    path.resolve(`ding-backup-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  fs.writeFileSync(out, JSON.stringify(payload, null, 2) + "\n", "utf8");

  if (p.flags.has("json")) {
    process.stdout.write(JSON.stringify({ ok: true, file: out, summary: payload.summary }, null, 2) + "\n");
    return 0;
  }
  process.stdout.write(
    [
      "备份完成。",
      `  文件：${out}`,
      `  内容：会话 ${payload.summary.sessions} 段 / 记录 ${payload.summary.records} 条 / 配置型 store ${payload.summary.stores} 项`,
      "",
      "  它是一个**能打开的 JSON 文件** —— 你可以自己看里面有什么，也可以拷到别的机器上恢复。",
      "  不含密钥（凭据在 ~/.dsh/.credentials.yaml，不跟着备份走）。",
      "",
    ].join("\n"),
  );
  return 0;
}

/**
 * `ding restore <文件> [--list]`。
 *
 * `--list` 只**看**不恢复（先让人确认这是不是他要的那份）。
 */
export async function cmdRestore(p: Parsed, dataDir: string): Promise<number> {
  const file = p.args[0] ?? flag(p, "out");
  if (!file) {
    process.stderr.write("用法：ding restore <备份文件> [--list]（--list 只看不恢复）\n");
    return 2;
  }
  const abs = path.resolve(file);
  if (!fs.existsSync(abs)) {
    process.stderr.write(`找不到备份文件：${abs}\n`);
    return 2;
  }

  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(abs, "utf8")) as unknown;
  } catch (error) {
    process.stderr.write(`这个文件不是合法 JSON（${(error as Error).message.slice(0, 80)}）—— 可能拷坏了\n`);
    return 2;
  }

  const checked = validateBackup(raw);
  if (!checked.ok) {
    process.stderr.write(`这份备份不能用：${checked.reason}\n`);
    return 2;
  }
  const payload = checked.payload;

  if (p.flags.has("list")) {
    process.stdout.write(describeBackup(payload) + "\n");
    return 0;
  }

  /*
   * ⚠️ 恢复**不删不覆盖**（见 `engine/core/backup.ts` 的硬规矩）：
   * 备份可能是三天前的，而这三天用户又聊了一堆 —— 直接覆盖等于用旧数据抹掉新的。
   */
  const store = createSqliteSessionStore(dataDir);
  try {
    const report = await applyBackup(payload, {
      loadSession: (id) => store.load(id),
      appendSession: (id, recs) => store.append(id, recs),
      writeStore: (key, value) => kvWrite(dataDir, key, value),
      writeConfig: (cfg) => {
        const paths = configPaths(dataDir);
        void paths;
        /* 只在**本机还没有配置**时写回 —— 有的话不动用户现在的设置（只补不覆盖） */
        if (!fs.existsSync(path.join(dataDir, "config.json"))) writeConfig(dataDir, cfg as never);
      },
    });

    if (p.flags.has("json")) {
      process.stdout.write(JSON.stringify({ ok: true, ...report }, null, 2) + "\n");
      return 0;
    }
    process.stdout.write(
      [
        "恢复完成（**只补不覆盖**：已有的记录与设置都没动）。",
        `  会话：${report.sessions} 段`,
        `  新增记录：${report.recordsAdded} 条`,
        `  跳过（本地已有）：${report.recordsSkipped} 条`,
        `  配置型 store：${report.stores} 项`,
        report.configRestored ? "  CLI 配置：已写回（本机原本没有配置）" : "  CLI 配置：本机已有配置，未覆盖",
        "",
        "  想完全回到备份那一刻：把数据目录里的 sessions.db / stores.db 挪走再恢复一次。",
        "",
      ].join("\n"),
    );
    return 0;
  } finally {
    store.close();
  }
}
