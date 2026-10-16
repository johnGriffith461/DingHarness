import fs from "node:fs";
import path from "node:path";

import { createSqliteSessionStore } from "../../engine/adapters/sqliteStore";
import { kvList, kvReadByKey, kvWriteKey, looksLikeForeignPathKey } from "../../engine/adapters/kvStore";
import { UNMAPPABLE_STORE_KEY, applyBackup, buildBackup, describeBackup, validateBackup } from "../../engine/core/backup";
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
 * 把备份里的 store 键映射到**本机**的键。
 *
 * - 新格式：键是**相对数据目录**的路径（`tasks.json`，见 `engine/adapters/kvStore.ts`）→ 直接用。
 * - 旧格式：键是本机绝对路径。只有它确实落在**本机**数据目录下才认得出（同机恢复）；
 *   别的机器的绝对路径没有人会去查，返回 `UNMAPPABLE_STORE_KEY` 让报告如实说"这几项没能恢复"，
 *   而不是把它们写进一串死键、然后在终端上说"恢复了 N 项"（P100/P128）。
 */
function mapStoreKey(dataDir: string, key: string): string | typeof UNMAPPABLE_STORE_KEY {
  if (!looksLikeForeignPathKey(key)) return key; // 新格式：相对数据目录的键，直接用
  /*
   * 路径形状：只有它确实是绝对路径、且落在**本机**数据目录下才认得出（同机恢复）。
   * `C:foo` 这种盘相对畸形一律不猜 —— 猜错的代价是把数据写进一串没人会查的键。
   */
  if (!path.isAbsolute(key)) return UNMAPPABLE_STORE_KEY;
  const base = path.resolve(dataDir);
  const rel = path.relative(base, path.resolve(key));
  const inside = rel.length > 0 && !rel.startsWith("..") && !path.isAbsolute(rel);
  return inside ? rel : UNMAPPABLE_STORE_KEY;
}

/**
 * `ding backup [--out <文件>] [--keep-provenance]`。
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
    // 默认只记目录名：完整路径带用户名/机器名，而这个文件是要拿去分享的（P145）
    keepProvenance: p.flags.has("keep-provenance"),
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
 *
 * ⚠️ 恢复是**只补不覆盖**（P99/P123/P196）：本机已有的键不动；备份里那些键若是
 * **另一台机器**的绝对路径（旧格式备份），本机认不出来 —— 那种会**明确报**出来
 * （`storesUnavailable`），而不是写进一串没人会查的键再报"恢复了 N 项"（P100/P128）。
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
   *
   * `readStore` 是那条规矩的落点：本机已经有这个键 → 跳过（P99/P123/P196）。
   * `writeStore` 按**本机**键写：备份里的键可能是导出机的绝对路径（P100/P128）。
   */
  const store = createSqliteSessionStore(dataDir);
  try {
    const report = await applyBackup(payload, {
      loadSession: (id) => store.load(id),
      appendSession: (id, recs) => store.append(id, recs),
      readStore: (key) => {
        const mapped = mapStoreKey(dataDir, key);
        return mapped === UNMAPPABLE_STORE_KEY ? UNMAPPABLE_STORE_KEY : kvReadByKey(dataDir, mapped);
      },
      writeStore: (key, value) => {
        const mapped = mapStoreKey(dataDir, key);
        if (mapped === UNMAPPABLE_STORE_KEY) return; // applyBackup 已把它记进 unavailable 并跳过
        kvWriteKey(dataDir, mapped, value);
      },
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
    const unavailableNote =
      report.storesUnavailable > 0
        ? `  ${report.storesUnavailable} 项没能恢复：它们的键是**另一台机器**的绝对路径（旧格式备份）；本机读不到那串键`
        : null;
    process.stdout.write(
      [
        "恢复完成（**只补不覆盖**：已有的记录与设置都没动）。",
        `  会话：${report.sessions} 段`,
        `  新增记录：${report.recordsAdded} 条`,
        `  跳过（本地已有同样的内容）：${report.recordsSkipped} 条`,
        `  配置型 store：补入 ${report.stores} 项 / 跳过（本机已有）${report.storesSkipped} 项`,
        report.configRestored ? "  CLI 配置：已写回（本机原本没有配置）" : "  CLI 配置：本机已有配置，未覆盖",
        ...(unavailableNote ? [unavailableNote] : []),
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
