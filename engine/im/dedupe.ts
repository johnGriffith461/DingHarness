import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

/**
 * IM 事件去重（V6-2f）。
 *
 * 平台会**重投**（飞书/Slack 都这样：没在几秒内回 200 就再来一次）。
 * 没有去重的话，同一句话会被执行两遍 —— 而 agent 的副作用（写文件、发命令）不可撤销。
 *
 * 落盘而不是只放内存：桥重启后平台仍可能重投（尤其是崩溃那一轮）。
 * 存最近 1000 个 id 就够（远大于平台的投递窗口）。
 */

export type SeenStore = {
  has: (eventId: string) => boolean;
  add: (eventId: string) => void;
  /** 已记录条数（测试/诊断用）。 */
  size: () => number;
};

const MAX_IDS = 1000;

/**
 * 打开一个去重表。
 *
 * @param file 落盘位置（父目录不存在时会建）
 */
export function openSeenStore(file: string): SeenStore {
  let ids: string[] = [];
  try {
    if (existsSync(file)) {
      const raw = JSON.parse(readFileSync(file, "utf8")) as { ids?: unknown };
      if (Array.isArray(raw.ids)) ids = raw.ids.filter((x): x is string => typeof x === "string").slice(-MAX_IDS);
    }
  } catch {
    /* 坏了就当空的：去重表丢了最多重复一次，不该让桥起不来 */
  }
  const set = new Set(ids);

  const persist = () => {
    try {
      mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.tmp`;
      writeFileSync(tmp, JSON.stringify({ ids: [...set].slice(-MAX_IDS) }), "utf8");
      renameSync(tmp, file);
    } catch {
      /* 落盘失败仍按内存去重（这一进程内不会重复） */
    }
  };

  return {
    has: (eventId) => set.has(eventId),
    add: (eventId) => {
      if (!eventId || set.has(eventId)) return;
      set.add(eventId);
      while (set.size > MAX_IDS) {
        const oldest = set.values().next().value;
        if (!oldest) break;
        set.delete(oldest);
      }
      persist();
    },
    size: () => set.size,
  };
}
