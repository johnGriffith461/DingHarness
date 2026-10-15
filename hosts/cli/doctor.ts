import fs from "node:fs";
import path from "node:path";

import { credentialsPath, hasSecret } from "../../engine/runtime/credentials";
import { allProviders, firstAvailableProvider, getProvider } from "../../engine/runtime/providers";
import { MODEL_CATALOG, STALE_DAYS, UNKNOWN_MODEL_BUDGET, isStale } from "../../engine/runtime/models";
import { CONFIRM_MODES, type ConfirmMode } from "../../shared/ipc";
import { sqliteRuntimeName } from "../../engine/adapters/sqliteDriver";
import { probeSandbox } from "../../engine/adapters/sandbox";
import { credentialProtection, secretsEncrypted } from "../../engine/adapters/secretStore";
import { createSqliteSessionStore } from "../../engine/adapters/sqliteStore";
import { normalizeConfig } from "./config";

/**
 * `ding doctor` —— 一键自检（Phase 11.4）。
 *
 * ## 与 `ding plugins doctor` 的区别
 *
 * 那个只查**插件**（装了什么、权限批没批、清单漂没漂）。这个是**整装自检**：
 * 用户说"跑不起来"时第一条该敲的命令。
 *
 * ## 方案的硬要求（11.4 的验收）
 *
 * > 每项失败都给出"下一步怎么做"的人话指引；**失败项 100% 带 actionable 指引**。
 *
 * 所以这里的 `Check` 形状里 `next` 是**必填**（不是可选）—— 不写下一步就编译不过。
 * 那比"记得写"可靠。
 *
 * ## 检查项与"为什么是这些"
 *
 * | 检查 | 挡的是哪一类"跑不起来" |
 * |---|---|
 * | 运行时 | Bun/Node 版本太低（`node:sqlite`/`bun:sqlite` 都没有） |
 * | 数据目录可写 | 装到了只读目录 / 权限不足 —— 建库会失败，但报错在很深的地方 |
 * | 会话库可开 | 旧库损坏 / 磁盘满 —— 这是"以前能用现在不能用"最常见的一种 |
 * | 凭据 | 一条 key 都没有 → 任何 provider 都用不了（**首次使用最常见的一格**） |
 * | provider 可用性 | 配了 provider 名但那条没有 key（"我明明配了啊"） |
 * | 模型 | 钉的模型不在目录表里 / 目录表数据过期超 90 天 |
 * | 配置合法性 | 配置文件里写了个不认识的档位（写错了但不报错，行为悄悄变） |
 * | 工作目录 | 配的目录不存在（工具会一律报"不在可写范围内"） |
 * | 沙箱 | **如实说"没有隔离"**（Phase 14 之前就是这样，不装） |
 */

/** 一项自检。 */
export type Check = {
  /** 报出来的一行标题。 */
  name: string;
  /** 过没过。 */
  ok: boolean;
  /** 现状（一句话，带具体数字/路径）。 */
  detail: string;
  /**
   * **过了也要写**：过的时候是"不用做什么"，没过的时候是"下一步做什么"。
   *
   * ⚠️ 必填是刻意的（方案 11.4 的验收是"失败项 100% 带 actionable 指引"）——
   * 可选字段会有人不写，必填字段不会。
   */
  next: string;
};

/** doctor 的输入（宿主给：数据目录、配置、平台信息）。 */
export type DoctorInput = {
  dataDir: string;
  configPath: string;
  rawConfig: unknown;
  /** 平台描述（`win32 x64 / Node 24.18.0` 这种）。 */
  runtime: string;
  /** 是不是 Bun 单二进制那条路。 */
  bunBinary: boolean;
};

/** 跑完整套自检。**不抛异常**：谁的机器都不该因为自检本身崩掉。 */
export function runDoctor(input: DoctorInput): Check[] {
  const out: Check[] = [];

  /* ① 运行时：够不够新 + **这个平台有哪些能力不可用**（如实标注，不装全能） */
  {
    const box = probeSandbox();
    const gaps: string[] = [];
    if (!box.bounded) gaps.push("命令的资源上限（Windows 才有作业对象实现）");
    if (!secretsEncrypted()) gaps.push("密钥的加密存储（CLI 侧没有系统钥匙串入口）");
    out.push({
      name: "运行时",
      ok: true,
      detail:
        `${input.runtime}，SQLite 驱动走 \`${sqliteRuntimeName()}:sqlite\`` +
        (gaps.length ? `；本平台**没有**：${gaps.join("、")}` : ""),
      next: gaps.length
        ? "这些是已知的平台差异（README 的「平台覆盖」一节列了全表）—— 别把它们当成已具备的保护"
        : "无需处理（这一格只在你看到 migrate/upgrade 提示时才需要动）",
    });
  }

  /* ② 数据目录可写 */
  {
    let ok = false;
    let detail = "";
    try {
      fs.mkdirSync(input.dataDir, { recursive: true });
      const probe = path.join(input.dataDir, ".doctor-probe");
      fs.writeFileSync(probe, "ok", "utf8");
      fs.rmSync(probe, { force: true });
      ok = true;
      detail = input.dataDir;
    } catch (error) {
      detail = `${input.dataDir}：${(error as Error)?.message?.slice(0, 80) ?? "写不进去"}`;
    }
    out.push({
      name: "数据目录可写",
      ok,
      detail,
      next: ok
        ? "无需处理"
        : "换个可写目录：`DH_DATA_DIR=<某个你有权限的目录> ding …`，或给这个目录写权限",
    });
  }

  /* ③ 会话库能打开（"以前能用现在不能用"最常见的一种） */
  {
    const dbFile = path.join(input.dataDir, "sessions.db");
    const existed = fs.existsSync(dbFile);
    let ok = false;
    let detail = "";
    try {
      const store = createSqliteSessionStore(input.dataDir);
      void store.list();
      store.close();
      ok = true;
      detail = existed ? `已存在，能打开：${dbFile}` : `还没有会话库（第一次跑会自动建）：${dbFile}`;
    } catch (error) {
      detail = `${dbFile}：${(error as Error)?.message?.slice(0, 100) ?? "打不开"}`;
    }
    out.push({
      name: "会话库可打开",
      ok,
      detail,
      next: ok
        ? "无需处理"
        : existed
          ? `库可能损坏或磁盘满。先备份再重建：把 ${dbFile} 改名（例如加 .bak）后重跑，旧库里的事件还在那个文件里`
          : "检查磁盘剩余空间，再重跑一次",
    });
  }

  /* ④ 凭据：一条都没有的话后面什么都别谈 */
  const providers = allProviders().filter((p) => p.id !== "strata");
  const withKey = providers.filter((p) => hasSecret(p.keyRef));
  {
    const file = credentialsPath();
    const ok = withKey.length > 0;
    out.push({
      name: "模型凭据",
      ok,
      detail: ok
        ? `${withKey.length} 家可用：${withKey.map((p) => p.id).join(" / ")}（key 来自环境变量或 ${file}）`
        : `一条都读不到（找过环境变量与 ${file}）`,
      next: ok
        ? "无需处理"
        : `跑一次 \`ding init\` 会带你配好；或手动：把 key 写进 ${file}，比如 \`DEEPSEEK_API_KEY: sk-…\``,
    });
  }

  /* ⑤ provider：配了名字但那条没 key（"我明明配了啊"） */
  {
    const cfg = normalizeConfig(input.rawConfig);
    const wanted = cfg.provider;
    const def = wanted ? getProvider(wanted) : undefined;
    if (!wanted) {
      const pick = firstAvailableProvider();
      out.push({
        name: "默认 provider",
        ok: Boolean(pick),
        detail: pick ? `没配，按"第一个有密钥的"选：${pick.id}` : "没配，而且没有一家有密钥",
        next: pick
          ? `想固定下来就写进配置：ding config set provider ${pick.id}`
          : "先配一条 key：跑 `ding init`（三件事两分钟），或按上一格的说明写进凭据文件",
      });
    } else if (!def) {
      out.push({
        name: "默认 provider",
        ok: false,
        detail: `配置里写的是「${wanted}」，但内置表里没有这家`,
        next: `改成表里的一家（ding models 能看到全部），或删掉这项：ding config unset provider`,
      });
    } else {
      const has = hasSecret(def.keyRef);
      out.push({
        name: "默认 provider",
        ok: has,
        detail: has ? `${def.id}（${def.label}）` : `${def.id} 没有密钥（找的是 ${def.keyRef}）`,
        next: has ? "无需处理" : `给 ${def.id} 配 ${def.keyRef}，或者换一家：ding config set provider <有 key 的那家>`,
      });
    }
  }

  /* ⑥ 模型：钉的那个在不在目录表里 + 目录表数据新不新鲜 */
  {
    const cfg = normalizeConfig(input.rawConfig);
    const model = cfg.model;
    if (model) {
      const known = MODEL_CATALOG.some((m) => m.id === model);
      out.push({
        name: "默认模型",
        ok: known,
        detail: known ? `${model}（目录表里有它）` : `${model} 不在目录表里`,
        next: known
          ? "无需处理"
          : `换一个：ding config set model <ding models 里列出的>；未登记模型也能跑，但上下文按保守默认 ${UNKNOWN_MODEL_BUDGET.contextWindow}，单价未知`,
      });
    }
    const stale = MODEL_CATALOG.filter((m) => isStale(m)).length;
    const ok = stale === 0;
    out.push({
      name: "模型目录新鲜度",
      ok,
      detail: ok
        ? `全部在 ${STALE_DAYS} 天内核实过（共 ${MODEL_CATALOG.length} 条）`
        : `${stale}/${MODEL_CATALOG.length} 条的核实日期超过 ${STALE_DAYS} 天`,
      next: ok ? "无需处理" : "刷新快照：pnpm vendor:models（会重算价格与上下文）",
    });
  }

  /* ⑦ 配置合法性：写错的值不该悄悄改变行为 */
  {
    const raw = input.rawConfig;
    const rawMode = raw && typeof raw === "object" ? (raw as Record<string, unknown>).mode : undefined;
    /*
     * ⚠️ 判据是"**原文**在不在可选值里"，不是"收窄后有没有值" ——
     * 收窄（`normalizeConfirmMode`）会把不认识的**回落**成默认档，所以收窄后永远有值。
     * 第一版按收窄后的值判，于是写错了档位也报"合法"（那一格形同虚设）。
     */
    const modeBad = rawMode !== undefined && !CONFIRM_MODES.includes(rawMode as ConfirmMode);
    out.push({
      name: "配置文件合法",
      ok: !modeBad,
      detail: modeBad ? `mode 写的是 ${JSON.stringify(rawMode)}，不认识` : input.configPath,
      next: modeBad
        ? "档位只能写：全部允许 / 按需确认 / 每步确认（写错会被忽略并回落到默认档）"
        : "无需处理",
    });
  }

  /* ⑧ 工作目录：配了但不存在的目录，工具会一律报"不在可写范围内" */
  {
    const cfg = normalizeConfig(input.rawConfig);
    const dirs = cfg.dirs ?? [];
    const missing = dirs.filter((d) => !fs.existsSync(d));
    const ok = missing.length === 0;
    out.push({
      name: "工作目录",
      ok,
      detail: dirs.length === 0 ? "没配（每次跑用当前目录）" : ok ? dirs.join(" / ") : `这些不存在：${missing.join(" / ")}`,
      next: ok
        ? dirs.length === 0
          ? "想让 agent 固定看某个目录：ding config set dirs <目录>"
          : "无需处理"
        : "删掉失效项或改对路径：ding config unset dirs 后重设",
    });
  }

  /* ⑨ 命令隔离（Phase 14.1）：**如实说清有哪一层、没有哪一层** */
  {
    const box = probeSandbox();
    out.push({
      name: "命令隔离",
      ok: true, // 不是"必须过"的检查项 —— 没有沙箱也能用，只是要知道边界
      /*
       * ⚠️ "**不是安全边界**"这句**两种情况都要说**：作业对象挡的是失控，不是恶意 ——
       * 有沙箱时不说这句，用户会以为"有沙箱 = 安全"，而那正是最危险的误解
       * （SAFETY.md 里那句"挡的是失控，不是恶意"就是同一件事的另一种写法）。
       */
      detail: box.found
        ? `${box.note}（**不是安全边界**：命令仍以你的身份跑，能读能写能联网）`
        : "run_command **没有沙箱**：它和 ding 同权限跑（闸门会先问，但问过之后就是全权限）",
      next: box.found
        ? "知道边界就好：它挡的是失控（吃光内存 / 起无数子进程 / 留孤儿），不是恶意"
        : "想有资源上限：pnpm sandbox:build（需要 Rust）。它挡的是失控，不是恶意",
    });
  }

  /* ⑩ 凭据保护（Phase 14.2）：说清我们的密钥是不是加密存的 */
  {
    const protection = credentialProtection(input.dataDir);
    out.push({
      name: "凭据保护",
      ok: true,
      detail: protection.detail,
      next: protection.next,
    });
  }

  return out;
}

/** 把自检结果写成给人看的文本。 */
export function formatDoctor(checks: readonly Check[], opts: { json: boolean }): string {
  if (opts.json) {
    return JSON.stringify(
      {
        ok: checks.every((c) => c.ok),
        failed: checks.filter((c) => !c.ok).length,
        checks,
      },
      null,
      2,
    );
  }
  const lines = ["ding doctor —— 一键自检", ""];
  for (const c of checks) {
    lines.push(`${c.ok ? "✓" : "✗"} ${c.name}：${c.detail}`);
    if (!c.ok) lines.push(`    下一步：${c.next}`);
  }
  const failed = checks.filter((c) => !c.ok);
  lines.push("");
  lines.push(
    failed.length
      ? `有 ${failed.length} 项需要处理（上面每一项都写了下一步）。`
      : `全部通过（${checks.length} 项）。`,
  );
  return lines.join("\n");
}

/** 一行摘要（`ding run` 之类的地方可以顺手打一句）。 */
export function doctorSummary(checks: readonly Check[]): string {
  const failed = checks.filter((c) => !c.ok);
  return failed.length ? `${failed.length} 项待处理：${failed.map((c) => c.name).join(" / ")}` : "自检全通过";
}

/** 保留给将来的"跑一次就自动修"（现在只报告，不改用户的机器）。 */
export const DOCTOR_NOTE = `doctor 只报告，不动你的机器（除了一次探针写入，写完就删）。`;
