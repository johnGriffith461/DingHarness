/**
 * **数据目录的选择**（M-08，纯函数）。
 *
 * 主人报的第 6 条：装完有两条"我们的任务"。根因不是安装包，而是
 * **dev 与装机版共用 `%APPDATA%\ding-harness`** —— 调试时写进去的会话，
 * 用户装完就看到它们了。
 *
 * 现在的规则（优先级从高到低）：
 * 1. 显式覆盖（`DING_DATA_DIR` / 旧名）—— 验收与便携模式用；
 * 2. 未打包（`electron .` / dev）→ `%APPDATA%\ding-harness-dev`；
 * 3. 打包版 → Electron 默认的 userData（`%APPDATA%\Ding Harness`）。
 *
 * 这个函数必须**在任何 `app.getPath("userData")` 之前**被调用（见 `electron/main.ts`）。
 */

export const DEV_PROFILE_DIRNAME = "ding-harness-dev";

export type UserDataChoice = {
  /** 最终要 setPath 的值。 */
  userData: string;
  /** 为什么是它（写进 boot.log，排障时不用猜）。 */
  reason: "override" | "dev" | "packaged";
};

export function resolveUserData(input: {
  isPackaged: boolean;
  /** 显式覆盖（已 trim；空串视为没有）。 */
  override?: string;
  appData: string;
  /** Electron 当前（默认）的 userData。 */
  currentUserData: string;
  /** 路径拼接（测试注入；默认由调用方传 path.join）。 */
  join?: (a: string, b: string) => string;
}): UserDataChoice {
  const override = String(input.override ?? "").trim();
  if (override) return { userData: override, reason: "override" };
  if (!input.isPackaged) {
    const join = input.join ?? ((a, b) => `${a}/${b}`);
    return { userData: join(input.appData, DEV_PROFILE_DIRNAME), reason: "dev" };
  }
  return { userData: input.currentUserData, reason: "packaged" };
}
