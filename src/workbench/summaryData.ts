/**
 * 右摘要面板要显示的两组数据（2026-10-16，审计 P82）。
 *
 * ## 为什么单独一个文件
 *
 * 面板里那两块原来是**写死的「暂无」**：输入区那条正显示「启用了 3 个」的技能 chip，
 * 右栏同一屏却说「暂无」—— 同一个 store 的数据，两处说法相反（P82）。
 * 而「最近文件」也一样：会话里明明读过/写过文件（工具留痕里就有路径），面板却说没有。
 *
 * 这两组数据都要从**已有**的地方推出来（不新增状态）：
 *   · 技能 = `useLibraryStore` 里 `enabled` 的条目名字（输入区那份 chip 用的是同一个来源）；
 *   · 最近文件 = 这一步/这段会话的工具留痕里出现过的**绝对路径**（去重、最近优先）。
 * 抽成纯函数是为了能单独测：面板本身是 React + 一堆 props，测它得先把环境搭起来，
 * 而"该显示什么"这件事其实一点都不依赖 React。
 */

import { extractFilePaths } from "./fileContext";
import type { WorkTask } from "./task";

export type RecentFile = {
  /** 文件名（界面上显示这个，路径放到 title 里）。 */
  name: string;
  /** 完整路径（点开/悬停要看得到"到底是哪个"）。 */
  path: string;
};

/** 从完整路径里取文件名（Windows 与 POSIX 两种分隔符都认）。 */
export function baseNameOf(filePath: string): string {
  const parts = filePath.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? filePath;
}

/**
 * 这段任务里**碰过的文件**（最近优先、去重）。
 *
 * 来源按"离用户最近"排：工具留痕（读/写/跑命令那几行）与资料（@ 添加的）都在里面。
 * 从后往前走步骤 —— 越靠后的步骤越新。
 *
 * @param task 任务
 * @param limit 最多几条
 * @returns 最近文件（新的在前）
 */
export function recentFilesOf(task: WorkTask | null, limit = 6): RecentFile[] {
  if (!task) return [];
  const seen = new Set<string>();
  const out: RecentFile[] = [];
  const push = (path: string) => {
    const key = path.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ name: baseNameOf(path), path });
  };

  /* 资料（用户 @ 进来的）算"最近"：那是他明确指给这次任务的文件 */
  for (const path of extractFilePaths(task.material ?? "")) push(path);

  for (let i = task.steps.length - 1; i >= 0 && out.length < limit; i -= 1) {
    const step = task.steps[i]!;
    /* 一步里的多次调用也是**先后有序**的（后调用的写在后面）—— 一起倒着走，整份清单才是严格"新在前" */
    const traces = step.tools ?? [];
    for (let t = traces.length - 1; t >= 0; t -= 1) {
      for (const path of extractFilePaths(traces[t]!.line ?? "")) push(path);
    }
  }
  return out.slice(0, limit);
}

/**
 * 启用的技能/插件名字（与输入区那排 chip **同一来源**，免得两处说法不同）。
 *
 * @param lib 资料库
 * @param findName 按 id 取名字（内置目录 + 用户自定义都要认；调用方传 `findItemIn`）
 * @returns 名字（顺序照 `enabled`）
 */
export function enabledSkillNames(lib: { enabled: string[] }, findName: (id: string) => string | undefined): string[] {
  return lib.enabled.map((id) => findName(id)).filter((name): name is string => Boolean(name));
}
