/**
 * **插件依赖**（L04 插件市场 v2）。
 *
 * ## 为什么需要它
 *
 * 一个插件在清单里声明"我要用 `word-count` 的统计能力"之前，只能靠 README 写一句
 * "请先装 xxx"。用户漏装时，插件要么静默少一个工具，要么在运行到一半时炸 ——
 * 两种都比"装之前就说清楚"坏。
 *
 * ## 语义（刻意小）
 *
 * - `dependencies` 是 `插件名 → 版本范围`，范围语法与 `engines.ding` **同一套**
 *   （`satisfiesEngines`），不另造一门语言；
 * - 依赖必须**已安装且开着**：装了但 disabled 与没装，对使用者是同一件事；
 * - 安装时缺依赖 → 拒绝，并列出缺哪个、要什么范围、现在是什么；
 * - 装载时缺依赖 → **不装载**，把原因放进 `problems`（界面/`plugins list` 会显示）。
 *
 * 不做自动递归安装：那意味着"装 A 顺便在网上取了 B、C" —— 每一次下载都该是
 * 用户看过的，而不是被依赖图替他决定的。
 */

import { satisfiesEngines } from "./pluginIndex";
import type { PluginManifest } from "./plugins";

/** 一个已安装插件的可判事实（不需要整个台账）。 */
export type InstalledFacts = { name: string; version: string; enabled: boolean };

/** 插件名与清单校验同一套形状（首字母小写，2–41 字符）。 */
const PLUGIN_NAME_RE = /^[a-z][a-z0-9-]{1,40}$/;

/**
 * 收窄清单里的 `dependencies`。
 *
 * @param raw 未知形状的输入
 * @returns 依赖表 + 错误（错误要能直接给用户看）
 */
export function parseDependencies(raw: unknown): { deps: Record<string, string>; errors: string[] } {
  if (raw === undefined || raw === null) return { deps: {}, errors: [] };
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return { deps: {}, errors: ["dependencies 必须是对象（插件名 → 版本范围，例如 {\"word-count\": \"^1.0.0\"}）"] };
  }
  const deps: Record<string, string> = {};
  const errors: string[] = [];
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const name = key.trim();
    if (!PLUGIN_NAME_RE.test(name)) {
      errors.push(`dependencies 里的插件名不合法：${JSON.stringify(key)}（与插件名同一套形状）`);
      continue;
    }
    if (typeof value !== "string" || !value.trim()) {
      errors.push(`dependencies.${name} 必须是版本范围字符串（例如 "^1.0.0" / ">=0.2" / "*")`);
      continue;
    }
    deps[name] = value.trim();
  }
  return { deps, errors };
}

/**
 * 这份清单的依赖有哪些没满足。
 *
 * @param manifest 清单（`dependencies` 可能没有）
 * @param installed 已安装的插件事实
 * @returns 每条都能直接给用户看；空数组 = 全部满足
 */
export function dependencyProblems(
  manifest: Pick<PluginManifest, "name" | "dependencies">,
  installed: readonly InstalledFacts[],
): string[] {
  const deps = manifest.dependencies ?? {};
  const problems: string[] = [];
  for (const [name, range] of Object.entries(deps)) {
    if (name === manifest.name) {
      problems.push(`依赖里写了自己（${name}）—— 自己依赖自己永远装不上，删掉这一条`);
      continue;
    }
    const found = installed.find((item) => item.name === name);
    if (!found) {
      problems.push(`缺依赖「${name}」${range}：先装它（ding plugins install <目录|npm:包名|index:${name}> --yes）`);
      continue;
    }
    if (!found.enabled) {
      problems.push(`依赖「${name}」装了但关着（ding plugins enable ${name}）`);
      continue;
    }
    if (!satisfiesEngines(range, found.version)) {
      problems.push(`依赖「${name}」版本不符：需要 ${range}，装的是 ${found.version}`);
    }
  }
  return problems;
}

/**
 * 一个插件的依赖图上是否存在环（诊断用；环本身不阻止安装，但值得报出来）。
 *
 * @param start 起点插件名
 * @param depsOf 取某个插件的依赖表（未安装的返回空）
 * @returns 环上的插件名（没有环返回空数组）
 */
export function dependencyCycle(
  start: string,
  depsOf: (name: string) => Record<string, string>,
): string[] {
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const path: string[] = [];

  const walk = (name: string): string[] | null => {
    if (visiting.has(name)) {
      const at = path.indexOf(name);
      return at >= 0 ? [...path.slice(at), name] : [name, name];
    }
    if (visited.has(name)) return null;
    visiting.add(name);
    path.push(name);
    for (const dep of Object.keys(depsOf(name))) {
      const hit = walk(dep);
      if (hit) return hit;
    }
    path.pop();
    visiting.delete(name);
    visited.add(name);
    return null;
  };

  return walk(start) ?? [];
}
