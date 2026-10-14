import path from "node:path";

/**
 * 云盘路径的**归属判断**（A1）。
 *
 * ## 为什么单独一个文件
 *
 * 这条判断原来长在 `driveStore.ts` 里（`insideOwnedDirs`），而那个文件**顶层 `import` 了 `electron`**。
 * 后果有两个：
 *
 * 1. 这份"判断"在 Electron 之外**一行都跑不了** —— 想验它只能真启一个应用；
 * 2. 本项目主进程**没有测试基础设施**（`vitest.config.ts` 只收 `src/` 下的 `*.test.ts`），
 *    于是它没有任何断言钉着：`drive:read` 与 `drive:rename` 漏掉这次校验时，
 *    **没有任何一条测试会红**。
 *
 * 抽到这个文件之后，依赖只剩 `node:path`（**不 import electron**）：
 * 主进程照旧用，`src/workbench/drivePaths.test.ts` 也能直接 `import` 它做真断言
 * （`tsconfig.json` 的 `include` 本就含 `electron`）。
 *
 * ⚠️ 判断口径**与原实现逐字一致**（`rel === ""` 即"目录自身"仍然放行）——
 * A1 只要求让两个漏掉的 handler **走同一道校验**，不改这道校验本身的语义，
 * 否则 `remove` / `duplicate` / `reveal` / `open` 的行为会跟着一起变。
 * "目录自身"那一路另由各 handler 自己挡（例如 `rename` 要求源必须是普通文件）。
 *
 * @param raw 渲染进程给的路径（**不可信**，见下）
 * @param dirs 允许的目录白名单（绝对路径）
 * @returns 通过校验的绝对路径；不通过返回 `null`
 */
export function insideDirs(raw: string, dirs: readonly string[]): string | null {
  /*
   * 跨进程边界上必须挡一手：不校验的话渲染进程传任意路径，
   * 就能让主进程删它 / 打开它 / 读它 —— 叠加 `electron/main.ts` 的 `sandbox: false`
   * （渲染进程与主进程同权限），这个口子的含义不只是"越权读一个文件"。
   */
  const resolved = path.resolve(String(raw ?? ""));
  for (const dir of dirs) {
    const rel = path.relative(path.resolve(dir), resolved);
    if (!rel.startsWith("..") && !path.isAbsolute(rel)) return resolved;
  }
  return null;
}
