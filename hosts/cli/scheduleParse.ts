import type { RepeatType } from "../../shared/schedule";

/**
 * 中文自然语言 → 定时规则（V6-2g）。
 *
 * ## 它不假装是 NLP
 *
 * 只认几种**明确、常见**的说法，认不出来就返回 null 让调用方报错。
 * 为什么不做"更通用"的解析：解析错的定时任务比没有更坏 —— 用户以为"每天 9 点"，
 * 实际每 7 天跑一次，等到发现时已经错过了。
 *
 * 支持：
 * - `每 15 分钟` / `每15分钟` → custom
 * - `每小时` → hourly
 * - `每天 9 点` / `每天 9:30` / `每天21点的周报` → daily + atHour/atMinute
 * - `每周四 16 点` → weekly + atHour/atMinute（**每 7 天，不按星期几** —— 模型没有星期几字段，如实标注）
 *
 * 不认：`明天`、`下周一`、`工作日`、`每月 1 号`（没有对应字段，不硬编）。
 */

export type ParsedSchedule = {
  repeat: RepeatType;
  atHour?: number;
  atMinute?: number;
  customMinutes?: number;
  /** 解析时的一句说明（例如 weekly 的"不按星期几"）。 */
  note?: string;
};

/** 全角数字/冒号归一。 */
function normalize(text: string): string {
  return text
    .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/[：]/g, ":")
    .replace(/\s+/g, " ")
    .trim();
}

function clockOf(hourText: string, minuteText?: string): { atHour: number; atMinute: number } | null {
  const hour = Number(hourText);
  const minute = minuteText === undefined ? 0 : Number(minuteText);
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) return null;
  if (!Number.isInteger(minute) || minute < 0 || minute > 59) return null;
  return { atHour: hour, atMinute: minute };
}

/**
 * 解析一句中文时间规则。
 *
 * @param raw 用户说的话
 * @returns 规则；认不出返回 null
 */
export function parseNaturalSchedule(raw: string): ParsedSchedule | null {
  const text = normalize(raw);
  if (!text) return null;

  const perMinutes = /每\s*(\d{1,4})\s*分钟/.exec(text);
  if (perMinutes) {
    const minutes = Number(perMinutes[1]);
    if (!Number.isFinite(minutes) || minutes <= 0) return null;
    return { repeat: "custom", customMinutes: minutes };
  }

  if (/每小时/.test(text)) return { repeat: "hourly" };

  const weekly = /每\s*(?:周|星期|礼拜)\s*[一二三四五六日天]?\s*(\d{1,2})(?:[:点](\d{1,2}))?\s*点?/.exec(text);
  if (weekly) {
    const clock = clockOf(weekly[1]!, weekly[2]);
    if (!clock) return null;
    return {
      repeat: "weekly",
      ...clock,
      note: "每周档是「每 7 天的这个钟点」—— 没有星期几的概念（调度模型里没有这个字段）",
    };
  }

  const daily = /每\s*(?:天|日)\s*(\d{1,2})(?:[:点](\d{1,2}))?\s*点?/.exec(text);
  if (daily) {
    const clock = clockOf(daily[1]!, daily[2]);
    if (!clock) return null;
    return { repeat: "daily", ...clock };
  }

  return null;
}
