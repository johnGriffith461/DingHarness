import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { normalizeJobs } from "../../shared/schedule";
import { readJobs, schedulesFile, writeJobs } from "./scheduleFile";
import { parseNaturalSchedule } from "./scheduleParse";

/**
 * 定时任务的中文解析与落盘（V6-2g）。
 *
 * 解析只认明确说法 —— 认不出就返回 null 让命令报错，**不猜**。
 * 猜错的定时任务比没有更坏：用户以为"每天 9 点"，实际每 7 天跑一次。
 */

describe("中文时间解析", () => {
  it("每天 / 每小时 / 每 N 分钟", () => {
    expect(parseNaturalSchedule("每天 9 点")).toMatchObject({ repeat: "daily", atHour: 9, atMinute: 0 });
    expect(parseNaturalSchedule("每天9:30")).toMatchObject({ repeat: "daily", atHour: 9, atMinute: 30 });
    expect(parseNaturalSchedule("每天21点的周报")).toMatchObject({ repeat: "daily", atHour: 21, atMinute: 0 });
    expect(parseNaturalSchedule("每小时")).toEqual({ repeat: "hourly" });
    expect(parseNaturalSchedule("每 15 分钟")).toMatchObject({ repeat: "custom", customMinutes: 15 });
  });

  it("每周：按钟点算，但**如实说明**没有星期几", () => {
    const weekly = parseNaturalSchedule("每周四 16 点")!;
    expect(weekly).toMatchObject({ repeat: "weekly", atHour: 16, atMinute: 0 });
    expect(weekly.note).toContain("星期");
  });

  it("认不出 / 非法钟点 → null（不猜）", () => {
    expect(parseNaturalSchedule("明天早上")).toBeNull();
    expect(parseNaturalSchedule("每月 1 号")).toBeNull();
    expect(parseNaturalSchedule("每天 25 点")).toBeNull();
    expect(parseNaturalSchedule("")).toBeNull();
  });
});

describe("任务文件（与桌面共用）", () => {
  const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "dh-sched-"));

  it("信封与裸数组都能读；写回是信封", () => {
    const dir = tmp();
    const job = {
      id: "j1",
      title: "早报",
      prompt: "汇总",
      repeat: "daily" as const,
      atHour: 9,
      atMinute: 0,
      status: "running" as const,
      createdAt: 1,
      lastRunAt: null,
      nextRunAt: 2,
      runs: [],
    };
    /* 裸数组（旧数据） */
    fs.writeFileSync(schedulesFile(dir), JSON.stringify([job]), "utf8");
    expect(readJobs(dir)).toHaveLength(1);
    /* 写回后是信封 */
    writeJobs(dir, readJobs(dir));
    const raw = JSON.parse(fs.readFileSync(schedulesFile(dir), "utf8")) as { __schema?: number; data?: unknown };
    expect(raw.__schema).toBe(1);
    expect(Array.isArray(raw.data)).toBe(true);
    expect(normalizeJobs(raw.data)).toHaveLength(1);
  });

  it("文件不在 / 坏了：给空数组，不抛", () => {
    const dir = tmp();
    expect(readJobs(dir)).toEqual([]);
    fs.writeFileSync(schedulesFile(dir), "{not json", "utf8");
    expect(readJobs(dir)).toEqual([]);
  });
});
