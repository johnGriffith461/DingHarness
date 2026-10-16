import { describe, expect, it } from "vitest";
import { JOB_STATUSES, MAX_CUSTOM_MINUTES, MIN_CUSTOM_MINUTES, REPEAT_LABEL, REPEAT_VALUES, afterRun, clampCustomMinutes, describeNextRun, dueJobs, makeJob, nextRunAt, normalizeJobs, type CronJob, validateJob } from "@shared/schedule";

const NOW = new Date("2026-10-11T20:00:00").getTime();
const job = (patch: Partial<CronJob> = {}): CronJob => ({ ...makeJob("j1", "每日新闻", "跑一下", "daily", NOW), ...patch });

describe("makeJob", () => {
  it("建出来就是 running，并算好了下次执行时间", () => {
    const j = makeJob("j1", "每日新闻推送", "汇总行业动态", "daily", NOW);
    expect(j.status).toBe("running");
    expect(j.nextRunAt).toBe(NOW + 24 * 60 * 60 * 1000);
    expect(j.lastRunAt).toBeNull();
    expect(j.runs).toEqual([]);
  });

  it("标题与 prompt 去掉首尾空白", () => {
    const j = makeJob("j1", "  日报  ", "  跑一下  ", "daily", NOW);
    expect(j.title).toBe("日报");
    expect(j.prompt).toBe("跑一下");
  });

  it("custom 档把间隔夹进合法范围", () => {
    expect(makeJob("j1", "t", "p", "custom", NOW, 99999).customMinutes).toBe(MAX_CUSTOM_MINUTES);
    expect(makeJob("j1", "t", "p", "custom", NOW, 0).customMinutes).toBe(MIN_CUSTOM_MINUTES);
  });

  it("非 custom 档不带 customMinutes", () => {
    expect(makeJob("j1", "t", "p", "daily", NOW, 30).customMinutes).toBeUndefined();
  });

  it("不重复任务的下次执行时间就是当下（等第一次触发）", () => {
    expect(makeJob("j1", "t", "p", "noRepeat", NOW).nextRunAt).toBe(NOW);
  });
});

describe("nextRunAt", () => {
  it("四档固定间隔", () => {
    expect(nextRunAt(job({ repeat: "hourly" }), NOW)).toBe(NOW + 3_600_000);
    expect(nextRunAt(job({ repeat: "daily" }), NOW)).toBe(NOW + 86_400_000);
    expect(nextRunAt(job({ repeat: "weekly" }), NOW)).toBe(NOW + 7 * 86_400_000);
  });

  it("custom 按分钟算", () => {
    expect(nextRunAt(job({ repeat: "custom", customMinutes: 30 }), NOW)).toBe(NOW + 30 * 60_000);
  });

  it("暂停的任务不再有下次执行时间", () => {
    expect(nextRunAt(job({ status: "paused" }), NOW)).toBeNull();
    expect(nextRunAt(job({ status: "finished" }), NOW)).toBeNull();
  });

  it("不重复任务跑过一次后就没有下次了", () => {
    expect(nextRunAt(job({ repeat: "noRepeat", lastRunAt: NOW }), NOW)).toBeNull();
    expect(nextRunAt(job({ repeat: "noRepeat", lastRunAt: null }), NOW)).toBe(NOW);
  });
});

describe("clampCustomMinutes", () => {
  it("夹进范围", () => {
    expect(clampCustomMinutes(30)).toBe(30);
    expect(clampCustomMinutes(1)).toBe(MIN_CUSTOM_MINUTES);
    expect(clampCustomMinutes(10_000_000)).toBe(MAX_CUSTOM_MINUTES);
  });

  it("非法值给默认 60 分钟（不能给 0 —— 那会让调度器每帧都触发）", () => {
    expect(clampCustomMinutes(undefined)).toBe(60);
    expect(clampCustomMinutes(Number.NaN)).toBe(60);
  });

  it("小数四舍五入", () => {
    expect(clampCustomMinutes(30.6)).toBe(31);
  });
});

describe("validateJob", () => {
  const base = { title: "日报", prompt: "跑一下", repeat: "daily" as const };

  it("合法草稿通过", () => {
    expect(validateJob(base)).toBeNull();
  });

  it("标题空要拦", () => {
    expect(validateJob({ ...base, title: "   " })).toContain("名字");
  });

  it("prompt 空要拦", () => {
    expect(validateJob({ ...base, prompt: "" })).toContain("做什么");
  });

  it("custom 档间隔超范围要拦（并说清范围）", () => {
    expect(validateJob({ ...base, repeat: "custom", customMinutes: 1 })).toContain(String(MIN_CUSTOM_MINUTES));
    expect(validateJob({ ...base, repeat: "custom", customMinutes: 999999 })).toContain(String(MAX_CUSTOM_MINUTES));
    expect(validateJob({ ...base, repeat: "custom", customMinutes: 30 })).toBeNull();
  });

  it("custom 档没填间隔要拦", () => {
    expect(validateJob({ ...base, repeat: "custom" })).toContain("分钟");
  });

  it("非 custom 档不看间隔（填了也不管）", () => {
    expect(validateJob({ ...base, customMinutes: 1 })).toBeNull();
  });
});

describe("dueJobs —— 挑出该跑的", () => {
  it("只挑到点且 running 的", () => {
    const jobs = [
      job({ id: "a", nextRunAt: NOW - 1000 }),
      job({ id: "b", nextRunAt: NOW + 1000 }),
      job({ id: "c", nextRunAt: NOW - 5000 }),
      job({ id: "d", nextRunAt: NOW - 3000, status: "paused" }),
    ];
    expect(dueJobs(jobs, NOW).map((j) => j.id)).toEqual(["c", "a"]);
  });

  it("按到期时间从早到晚（晚到的任务不能被后来的插队）", () => {
    const jobs = [
      job({ id: "late", nextRunAt: NOW - 100 }),
      job({ id: "early", nextRunAt: NOW - 9000 }),
    ];
    expect(dueJobs(jobs, NOW).map((j) => j.id)).toEqual(["early", "late"]);
  });

  it("nextRunAt 为 null 的永不触发", () => {
    expect(dueJobs([job({ id: "a", nextRunAt: null })], NOW)).toEqual([]);
  });

  it("没有到点的返回空", () => {
    expect(dueJobs([job({ id: "a", nextRunAt: NOW + 10000 })], NOW)).toEqual([]);
  });
});

describe("afterRun", () => {
  it("记一次成功，并排好下次", () => {
    const j = job({ repeat: "daily" });
    const next = afterRun(j, NOW, true);
    expect(next.lastRunAt).toBe(NOW);
    expect(next.nextRunAt).toBe(NOW + 86_400_000);
    expect(next.status).toBe("running");
    expect(next.runs[0]).toEqual({ at: NOW, ok: true });
  });

  it("不重复任务跑完就 finished", () => {
    const next = afterRun(job({ repeat: "noRepeat" }), NOW, true);
    expect(next.status).toBe("finished");
    expect(next.nextRunAt).toBeNull();
  });

  it("失败要记下错误说明", () => {
    const next = afterRun(job(), NOW, false, "模型超时");
    expect(next.runs[0]).toEqual({ at: NOW, ok: false, error: "模型超时" });
  });

  it("历史只留 20 条（长期跑不能让数组无限长）", () => {
    let j = job();
    for (let i = 0; i < 30; i += 1) j = afterRun(j, NOW + i, true);
    expect(j.runs).toHaveLength(20);
    // 最新的在前
    expect(j.runs[0].at).toBe(NOW + 29);
  });
});

describe("describeNextRun", () => {
  it("分 / 时 / 天三档", () => {
    expect(describeNextRun(NOW + 12 * 60_000, NOW)).toBe("12 分钟后");
    expect(describeNextRun(NOW + 3 * 3_600_000, NOW)).toBe("3 小时后");
    expect(describeNextRun(NOW + 2 * 86_400_000, NOW)).toBe("2 天后");
  });

  it("到点或过期显示「即将执行」", () => {
    expect(describeNextRun(NOW, NOW)).toBe("即将执行");
    expect(describeNextRun(NOW - 1000, NOW)).toBe("即将执行");
  });

  it("null 显示已结束", () => {
    expect(describeNextRun(null, NOW)).toBe("已结束");
  });
});

describe("标签表", () => {
  it("五档重复方式都有中文名", () => {
    for (const key of ["noRepeat", "hourly", "daily", "weekly", "custom"] as const) {
      expect(REPEAT_LABEL[key], key).toBeTruthy();
    }
  });

});


describe("从磁盘恢复任务（§178）", () => {
  const good = () => ({
    id: "j1",
    title: "每日新闻",
    prompt: "跑一下",
    repeat: "daily",
    status: "running",
    createdAt: NOW,
    lastRunAt: null,
    nextRunAt: NOW + 60_000,
    runs: [{ at: NOW - 1000, ok: true }],
  });

  it("⭐ 正常的一条原样活着（每个字段都在）", () => {
    const got = normalizeJobs([good()]);
    expect(got).toHaveLength(1);
    expect(got[0]?.title).toBe("每日新闻");
    expect(got[0]?.repeat).toBe("daily");
    expect(got[0]?.status).toBe("running");
    expect(got[0]?.nextRunAt).toBe(NOW + 60_000);
    expect(got[0]?.runs).toHaveLength(1);
  });

  it("⚠️ 没有 id / id 重复 → **丢掉**（管不了的任务留着只会添乱）", () => {
    expect(normalizeJobs([{ title: "没有 id" }])).toEqual([]);
    expect(normalizeJobs([good(), { ...good(), title: "重复 id" }])).toHaveLength(1);
  });

  it("⚠️ repeat 不认识 → **丢掉**（算不出下次运行时间，留着是个永远不响的坑）", () => {
    expect(normalizeJobs([{ ...good(), repeat: "每小时" }])).toEqual([]);
    expect(normalizeJobs([{ ...good(), repeat: undefined }])).toEqual([]);
  });

  it("⭐ status 不认识 → 当成 **paused**（当成 running 的话，一个坏字段就能让它自己跑起来）", () => {
    expect(normalizeJobs([{ ...good(), status: "什么" }])[0]?.status).toBe("paused");
    expect(normalizeJobs([{ ...good(), status: undefined }])[0]?.status).toBe("paused");
  });

  it("custom 档没有合法间隔就跑不起来 → 丢掉", () => {
    expect(normalizeJobs([{ ...good(), repeat: "custom" }])).toEqual([]);
    expect(normalizeJobs([{ ...good(), repeat: "custom", customMinutes: 1 }])).toEqual([]);
    expect(normalizeJobs([{ ...good(), repeat: "custom", customMinutes: 999999 }])).toEqual([]);
    expect(normalizeJobs([{ ...good(), repeat: "custom", customMinutes: 30 }])[0]?.customMinutes).toBe(30);
  });

  it("时间字段坏掉 → 给 null（不是 NaN —— NaN 会让界面显示 Invalid Date）", () => {
    /*
     * ⚠️ 2026-10-16（审计 G53.g）：原来断的是 `…[0]?.nextRunAt ?? null` —— 那个 `?? null`
     * 把"**字段整个消失**"也变成了通过（`undefined ?? null === null`）。
     * 而字段消失与字段为 null 对读的人不是一回事（界面上后者是"没有下次"，前者要查数据形状）。
     * 现在直接断**值**，并加一条正例（好的数据必须留着数字）。
     */
    const broken = normalizeJobs([{ ...good(), nextRunAt: "明天" }])[0];
    expect(broken?.nextRunAt).toBeNull();
    expect(broken && "nextRunAt" in broken, "坏值应当被归一化成 null，而不是把字段删掉").toBe(true);
    expect(normalizeJobs([{ ...good(), nextRunAt: NaN }])[0]?.nextRunAt).toBeNull();
    expect(normalizeJobs([{ ...good(), lastRunAt: "昨天" }])[0]?.lastRunAt).toBeNull();
    /* 正例：好的时间戳要原样留着（否则"全都给 null"也能让上面三条绿） */
    expect(normalizeJobs([{ ...good(), nextRunAt: NOW }])[0]?.nextRunAt).toBe(NOW);
  });

  it("执行历史里坏的那几条丢掉（缺 at 的、非对象的）", () => {
    const got = normalizeJobs([
      { ...good(), runs: [{ at: NOW, ok: true }, { ok: true }, null, "字符串", { at: "不是数字" }] },
    ]);
    expect(got[0]?.runs).toEqual([{ at: NOW, ok: true }]);
  });

  it("执行历史太长会截断", () => {
    const many = Array.from({ length: 80 }, (_, i) => ({ at: NOW + i, ok: true }));
    expect(normalizeJobs([{ ...good(), runs: many }])[0]?.runs.length).toBe(50);
  });

  it("标题/提示词坏了给空串（难看但比崩了强）", () => {
    const got = normalizeJobs([{ ...good(), title: 42, prompt: null }])[0];
    expect(got?.title).toBe("");
    expect(got?.prompt).toBe("");
  });

  it("整个文件不是数组 → 空列表（坏文件不许把应用卡住）", () => {
    expect(normalizeJobs(null)).toEqual([]);
    expect(normalizeJobs({ jobs: [] })).toEqual([]);
    expect(normalizeJobs("[]")).toEqual([]);
  });

  it("归一化是**幂等**的（跑两遍结果一样 —— 否则每次读回都在漂移）", () => {
    const once = normalizeJobs([good(), { ...good(), id: "j2", status: "什么" }]);
    expect(normalizeJobs(once)).toEqual(once);
  });

  it("⭐ 值表与联合类型必须一一对应（加了新档位忘了改这里，归一化会把新数据丢掉）", () => {
    expect(REPEAT_VALUES).toEqual(["noRepeat", "hourly", "daily", "weekly", "custom"]);
    expect(JOB_STATUSES).toEqual(["running", "paused", "finished", "deleted"]);
  });
});

describe("钟点（Phase 16：配得出「每晚 22:00」）", () => {
  it("⭐ 每天 22:00：从上午 11 点算，下一次是**当天** 22:00（不是 24 小时之后）", () => {
    const from = new Date(2026, 9, 15, 11, 37, 0).getTime();
    const next = nextRunAt(job({ atHour: 22 }), from);
    const d = new Date(next!);
    expect(d.getHours()).toBe(22);
    expect(d.getMinutes()).toBe(0);
    // 同一天（这才是"每晚 22 点"的意思）
    expect(d.getDate()).toBe(15);
  });

  it("当天那个钟点已经过了 → 落到第二天（否则一创建就立刻跑一次）", () => {
    const from = new Date(2026, 9, 15, 23, 30, 0).getTime();
    const next = nextRunAt(job({ atHour: 22 }), from);
    const d = new Date(next!);
    expect(d.getDate()).toBe(16);
    expect(d.getHours()).toBe(22);
  });

  it("带分钟：22:30 也配得出来", () => {
    const from = new Date(2026, 9, 15, 8, 0, 0).getTime();
    const d = new Date(nextRunAt(job({ atHour: 22, atMinute: 30 }), from)!);
    expect(d.getHours()).toBe(22);
    expect(d.getMinutes()).toBe(30);
  });

  it("weekly + 钟点：间隔仍是 7 天（**不假装有「星期几」**）", () => {
    const from = new Date(2026, 9, 15, 8, 0, 0).getTime();
    const d = new Date(nextRunAt(job({ repeat: "weekly", atHour: 9 }), from)!);
    expect(d.getHours()).toBe(9);
    expect(d.getMinutes()).toBe(0);
    // 当天 9 点还没到 → 就是当天 9 点；这说明 weekly 的钟点语义与 daily 一致（都是"最近的那个钟点"）
    expect(d.getDate()).toBe(15);
  });

  it("**没填钟点 = 老行为**（固定间隔）—— 不改老任务的时间", () => {
    const from = new Date(2026, 9, 15, 11, 37, 0).getTime();
    const next = nextRunAt(job({}), from);
    expect(next! - from).toBe(24 * 60 * 60 * 1000);
  });

  it("钟点写坏了（25 点）报错，而不是悄悄夹成 1 点", () => {
    expect(validateJob({ title: "x", prompt: "y", repeat: "daily", atHour: 25 })).toContain("0–23");
    expect(validateJob({ title: "x", prompt: "y", repeat: "daily", atHour: 22 })).toBeNull();
  });

  it("磁盘上的坏钟点当没填（回落老行为，不夹到边界）", () => {
    const got = normalizeJobs([
      { id: "a", title: "t", prompt: "p", repeat: "daily", status: "running", atHour: 99, createdAt: 0, lastRunAt: null, nextRunAt: null, runs: [] },
    ]);
    expect(got[0]?.atHour).toBeUndefined();
  });
});
