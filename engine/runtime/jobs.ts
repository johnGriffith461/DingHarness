import fs from "node:fs";
import path from "node:path";

/**
 * **后台任务记录**（G06，2026-10-18）。
 *
 * ## 它解决什么
 *
 * 长任务（跑测试、批量重构）不该把终端/窗口占住。CLI 已经能跑，但"跑完没有、
 * 成没成、日志在哪"没有地方看 —— 用户只能把终端开着等。
 *
 * 现在：`ding run "…" --background` 起一个**脱离的后台进程**，把它的输出写进
 * `<数据目录>/jobs/<id>.log`，并在 `jobs.jsonl` 记一条任务（开始/结束/退出码）。
 * `ding jobs list` 看列表、`ding jobs show <id>` 看尾部、`ding jobs wait <id>` 等它。
 *
 * ## 为什么是 append-only 的 JSONL 而不是一份 JSON 状态表
 *
 * 后台进程与查看命令是**两个进程**：状态表需要读-改-写（并发会互相覆盖），
 * 而 append-only 只需要追加 —— "最后一条同 id 的记录说了算"是天然的收敛规则。
 * 与事件日志同一个思路（这里只是不复用 `sessions.db`：任务记录不是会话事件）。
 */

/** 任务状态。 */
export type JobStatus = "running" | "finished" | "failed" | "cancelled";

/** 一条任务记录（**每次状态变化追加一条**）。 */
export type JobRecord = {
  id: string;
  status: JobStatus;
  at: number;
  /** 这段会话的 id（跑完可以用 `ding sessions --state` 看它）。 */
  sessionId?: string;
  /** 用户让它干什么（截断到 200 字：它是显示用的，不是证据）。 */
  prompt: string;
  /** 日志文件路径。 */
  logPath?: string;
  /** 进程退出码（终态才有）。 */
  exitCode?: number;
  error?: string;
};

/** 任务目录（`<dataDir>/jobs`）。 */
export const JOBS_DIR = "jobs";

/** 记录文件。 */
export function jobsFile(dataDir: string): string {
  return path.join(dataDir, "jobs.jsonl");
}

/** 日志文件名（id 已经是我们生成的，只做一次防御性清洗）。 */
export function jobLogPath(dataDir: string, id: string): string {
  return path.join(dataDir, JOBS_DIR, `${String(id).replace(/[^\w.-]+/g, "_").slice(0, 80) || "job"}.log`);
}

/** 追加一条记录（失败不抛 —— 记不下来不该让任务起不来）。 */
export function appendJob(dataDir: string, record: JobRecord): boolean {
  try {
    fs.mkdirSync(path.dirname(jobsFile(dataDir)), { recursive: true });
    fs.appendFileSync(jobsFile(dataDir), `${JSON.stringify(record)}\n`, "utf8");
    return true;
  } catch {
    return false;
  }
}

/**
 * 读全部任务（同 id 取**最后一条**）。
 *
 * @param dataDir 数据目录
 * @returns 任务（按开始时间倒序）
 */
export function listJobs(dataDir: string): JobRecord[] {
  let raw = "";
  try {
    raw = fs.readFileSync(jobsFile(dataDir), "utf8");
  } catch {
    return [];
  }
  const byId = new Map<string, JobRecord>();
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      const parsed = JSON.parse(t) as JobRecord;
      if (typeof parsed.id !== "string" || typeof parsed.status !== "string") continue;
      byId.set(parsed.id, { ...byId.get(parsed.id), ...parsed });
    } catch {
      /* 坏行跳过（写入被打断） */
    }
  }
  return [...byId.values()].sort((a, b) => b.at - a.at);
}

/**
 * 取一条任务。
 *
 * @param dataDir 数据目录
 * @param id 任务 id（支持前缀匹配：用户通常只记得开头几位）
 */
export function findJob(dataDir: string, id: string): JobRecord | undefined {
  const jobs = listJobs(dataDir);
  const exact = jobs.find((j) => j.id === id);
  if (exact) return exact;
  const prefix = jobs.filter((j) => j.id.startsWith(id));
  return prefix.length === 1 ? prefix[0] : undefined;
}

/** 读日志尾部（**不把整份日志读进内存**：它可能是几百 MB）。 */
export function tailLog(file: string, lines = 40, maxBytes = 64 * 1024): string {
  try {
    const stat = fs.statSync(file);
    const start = Math.max(0, stat.size - maxBytes);
    const fd = fs.openSync(file, "r");
    try {
      const buf = Buffer.alloc(stat.size - start);
      fs.readSync(fd, buf, 0, buf.length, start);
      const text = buf.toString("utf8");
      const all = text.split("\n");
      return all.slice(-lines).join("\n").trim();
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return "";
  }
}

/** 一行人话（CLI 列表用）。 */
export function describeJob(job: JobRecord): string {
  const when = new Date(job.at).toLocaleString("zh-CN");
  const state =
    job.status === "running"
      ? "运行中"
      : job.status === "finished"
        ? "已完成"
        : job.status === "cancelled"
          ? "已取消"
          : "失败";
  const code = typeof job.exitCode === "number" ? `（退出码 ${job.exitCode}）` : "";
  return `${job.id.padEnd(20)} ${state}${code}  ${when}  ${job.prompt}`;
}
