/**
 * 应用级通道名的单一来源（**审计 P66**）。
 *
 * `app:ping` / `app:userDataDir` 这两条原来在主进程（`main.ts`）与 preload
 * 两处**各写一遍裸字符串**。改通道名时两边不会一起报错，只会静默漂移成
 * "渲染层调了一个没人接的通道"。其余通道都各有自己的 `*_CHANNEL` 常量表，
 * 这两条没有 —— 这里补齐，两边都从这里取。
 *
 * ⚠️ 只有通道名（不涉及签名）；preload 那侧改的只是字符串来源，通道本身没变。
 */
export const APP_CHANNEL = {
  /** 主进程活着吗（含版本号）。 */
  ping: "app:ping",
  /** 数据目录（`app.getPath("userData")`）。 */
  userDataDir: "app:userDataDir",
} as const;
