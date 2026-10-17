/**
 * `ding schedule` —— 定时任务的**常驻执行器**（V6-2g）。
 *
 * ```
 * ding schedule add "每天 9 点" --title "早报" --prompt "汇总昨天的日志发我"
 * ding schedule list
 * ding schedule run-due                 # 跑一次到点的（cron 里挂这条也行）
 * ding schedule run-due --every 1       # 常驻：每分钟看一次（关掉终端才停）
 * ding schedule pause|resume|remove <id>
 * ```
 *
 * 与桌面的关系：**共用 `<数据目录>/schedules.json`**。桌面的调度在渲染层
 * （关窗即停是已知限制）；这个命令补的是"机器开着、窗口关着也要跑"。
 *
 * ⚠️ 会调真模型（花 token）：只在到点时执行，失败会记进 job.runs。
 */
import { randomUUID } from "node:crypto";

import { resolveSecret } from "../../engine/runtime/credentials";
import { allProviders, firstAvailableProvider } from "../../engine/runtime/providers";
import {
  afterRun,
  describeNextRun,
  dueJobs,
  nextRunAt,
  REPEAT_LABEL,
  validateJob,
  type CronJob,
  type RepeatType,
} from "../../shared/schedule";
import { buildEngine } from "./assembly";
import { flag, parseIntFlagValue, type Parsed } from "./args";
import { readConfig } from "./config";
import { readJobs, schedulesFile, writeJobs } from "./scheduleFile";
import { parseNaturalSchedule } from "./scheduleParse";

/** `9:30` / `9` → 钟点。 */
function parseClock(raw: string | undefined): { atHour: number; atMinute: number } | null | "bad" {
  if (!raw) return null;
  const m = /^(\d{1,2})(?::(\d{1,2}))?$/.exec(raw.trim());
  if (!m) return "bad";
  const hour = Number(m[1]);
  const minute = m[2] === undefined ? 0 : Number(m[2]);
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return "bad";
  return { atHour: hour, atMinute: minute };
}

/** 解析 provider/model（命令行 > 配置 > 第一个有 key 的）。 */
function resolveTarget(p: Parsed, dataDir: string): { provider: string; model?: string } | { error: string } {
  const config = readConfig(dataDir).config;
  const provider = flag(p, "provider") ?? config.provider ?? firstAvailableProvider(resolveSecret)?.id;
  if (!provider) return { error: "没有可用的 provider：先 ding init 配一个，或用 --provider 指定" };
  const known = allProviders().find((x) => x.id === provider);
  if (!known) return { error: `不认识的 provider：${provider}` };
  const model = flag(p, "model") ?? config.model ?? known.models[0];
  return { provider, ...(model ? { model } : {}) };
}

export async function cmdSchedule(p: Parsed, dataDir: string): Promise<number> {
  const sub = p.args[0] ?? "list";

  if (sub === "list") {
    const jobs = readJobs(dataDir);
    if (p.flags.has("json")) {
      process.stdout.write(JSON.stringify(jobs, null, 2) + "\n");
      return 0;
    }
    if (!jobs.length) {
      process.stdout.write(`还没有定时任务（文件：${schedulesFile(dataDir)}）\n`);
      return 0;
    }
    const now = Date.now();
    for (const job of jobs) {
      process.stdout.write(
        `${job.status === "running" ? "▶" : job.status === "paused" ? "⏸" : "■"} ${job.id}　${job.title}　[${REPEAT_LABEL[job.repeat]}` +
          (job.atHour !== undefined ? ` ${String(job.atHour).padStart(2, "0")}:${String(job.atMinute ?? 0).padStart(2, "0")}` : "") +
          (job.repeat === "custom" ? ` 每 ${job.customMinutes} 分钟` : "") +
          `]　下次：${describeNextRun(job.nextRunAt, now)}\n    ${job.prompt}\n`,
      );
    }
    return 0;
  }

  if (sub === "add") {
    const phrase = p.args.slice(1).join(" ").trim();
    const title = flag(p, "title");
    const prompt = flag(p, "prompt");
    if (!title || !prompt) {
      return usage("缺 --title 或 --prompt：要说清「叫什么」与「到点做什么」");
    }
    const repeatFlag = flag(p, "repeat") as RepeatType | undefined;
    let parsed;
    if (repeatFlag) {
      if (!["noRepeat", "hourly", "daily", "weekly", "custom"].includes(repeatFlag)) {
        return usage(`--repeat 只能是 noRepeat/hourly/daily/weekly/custom（给了「${repeatFlag}」）`);
      }
      if (repeatFlag === "custom") {
        const minutes = parseIntFlagValue(flag(p, "every"), "every", { min: 5, max: 60 * 24 * 30, fallback: 60 });
        if (!minutes.ok) return usage(minutes.message);
        parsed = { repeat: repeatFlag, customMinutes: minutes.value };
      } else if (repeatFlag === "daily" || repeatFlag === "weekly") {
        const clock = parseClock(flag(p, "at") ?? "9:00");
        if (clock === "bad" || clock === null) return usage("--at 要写成 `9:30` 这种（0–23 时 / 0–59 分）");
        parsed = { repeat: repeatFlag, ...clock };
      } else {
        parsed = { repeat: repeatFlag };
      }
    } else {
      const natural = parseNaturalSchedule(phrase);
      if (!natural) {
        return usage(
          `认不出这句时间：「${phrase}」。支持：每 N 分钟 / 每小时 / 每天 9 点 / 每天 9:30 / 每周四 16 点；` +
            `也可以用 --repeat daily --at 9:30 明确给。`,
        );
      }
      parsed = natural;
      if (natural.note) process.stderr.write(`⚠️ ${natural.note}\n`);
    }

    const draft = {
      title,
      prompt,
      repeat: parsed.repeat,
      ...(parsed.customMinutes !== undefined ? { customMinutes: parsed.customMinutes } : {}),
      ...(parsed.atHour !== undefined ? { atHour: parsed.atHour } : {}),
      ...(parsed.atMinute !== undefined ? { atMinute: parsed.atMinute } : {}),
    };
    const problem = validateJob(draft);
    if (problem) return usage(problem);

    const now = Date.now();
    const job: CronJob = {
      id: `sched-${now.toString(36)}-${randomUUID().slice(0, 4)}`,
      ...draft,
      status: "running",
      createdAt: now,
      lastRunAt: null,
      nextRunAt: null,
      runs: [],
    };
    job.nextRunAt = nextRunAt(job, now);
    writeJobs(dataDir, [...readJobs(dataDir), job]);
    process.stdout.write(`✓ 建好了：${job.id}「${job.title}」，下次：${describeNextRun(job.nextRunAt, now)}\n`);
    process.stdout.write(`  常驻执行：ding schedule run-due --every 1\n`);
    return 0;
  }

  if (sub === "pause" || sub === "resume" || sub === "remove") {
    const id = p.args[1];
    if (!id) return usage(`用法：ding schedule ${sub} <id>`);
    const jobs = readJobs(dataDir);
    const job = jobs.find((x) => x.id === id);
    if (!job) return usage(`没有这个定时任务：${id}`);
    if (sub === "remove") {
      writeJobs(dataDir, jobs.filter((x) => x.id !== id));
      process.stdout.write(`✓ 删掉了 ${id}\n`);
      return 0;
    }
    const now = Date.now();
    const next: CronJob =
      sub === "pause"
        ? { ...job, status: "paused", nextRunAt: null }
        : { ...job, status: "running", nextRunAt: nextRunAt({ ...job, status: "running" }, now) };
    writeJobs(dataDir, jobs.map((x) => (x.id === id ? next : x)));
    process.stdout.write(`✓ ${id} 已${sub === "pause" ? "暂停" : "恢复"}${next.nextRunAt ? `（下次：${describeNextRun(next.nextRunAt, now)}）` : ""}\n`);
    return 0;
  }

  if (sub === "run-due") {
    const target = resolveTarget(p, dataDir);
    if ("error" in target) return usage(target.error);
    const every = flag(p, "every");
    const loop = every !== undefined && !p.flags.has("once");
    const minutes = loop ? parseIntFlagValue(every, "every", { min: 1, max: 1440, fallback: 1 }) : { ok: true as const, value: 0 };
    if (!minutes.ok) return usage(minutes.message);

    let stopping = false;
    const onSigint = () => {
      stopping = true;
      process.stderr.write("\n收到 Ctrl+C：跑完手上这一轮就停。\n");
    };
    process.on("SIGINT", onSigint);

    do {
      const now = Date.now();
      const jobs = readJobs(dataDir);
      const due = dueJobs(jobs, now);
      if (!due.length && !loop) {
        process.stdout.write(`现在没有到点的任务（共 ${jobs.length} 个）。\n`);
        break;
      }
      for (const job of due) {
        const at = Date.now();
        process.stdout.write(`▶ ${job.title}（${job.id}）\n`);
        let ok = false;
        let error: string | undefined;
        const built = await buildEngine([process.cwd()], dataDir);
        try {
          const outcome = await built.engine.run({
            sessionId: `cli-sched-${job.id}-${at.toString(36)}`,
            provider: target.provider,
            ...(target.model ? { model: target.model } : {}),
            system: "这是一个到点自动执行的定时任务。直接执行，不要反问用户。",
            messages: [{ role: "user", content: job.prompt }],
            mode: "按需确认",
            useTools: true,
            maxSteps: 8,
            onEvent: (event) => {
              if (event.type === "text") process.stdout.write(event.text);
              else if (event.type === "tool-call") process.stderr.write(`\n⚙ ${event.toolName}\n`);
              else if (event.type === "error") process.stderr.write(`\n${event.message}\n`);
            },
          });
          ok = outcome.ok;
          error = outcome.ok ? undefined : outcome.error;
        } catch (err) {
          error = String((err as Error)?.message ?? err);
        } finally {
          built.close();
        }
        process.stdout.write("\n");
        const updated = afterRun(job, at, ok, error);
        writeJobs(dataDir, readJobs(dataDir).map((x) => (x.id === job.id ? updated : x)));
        process.stdout.write(
          ok
            ? `✓ 完成；下次：${describeNextRun(updated.nextRunAt, Date.now())}\n`
            : `✗ 失败：${error ?? "未知错误"}（下次仍按计划：${describeNextRun(updated.nextRunAt, Date.now())}）\n`,
        );
      }
      if (!loop || stopping) break;
      await new Promise((resolve) => setTimeout(resolve, minutes.value * 60_000));
    } while (!stopping);

    process.off("SIGINT", onSigint);
    return 0;
  }

  return usage("用法：ding schedule list|add|pause|resume|remove|run-due …");
}

function usage(text: string): number {
  process.stderr.write(`${text}\n`);
  return 2;
}
