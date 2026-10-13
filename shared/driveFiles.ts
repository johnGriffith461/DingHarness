/**
 * 云盘的改名与读取（§158）—— 补 `drive_menuOption_rename` 与 `drive_menuOption_AIReading`。
 *
 * 分成纯逻辑（这里）与主进程操作（`electron/ipc/driveStore.ts`）两层：
 * **"能不能改名"是判断，"改不改得成"是文件系统的事**。
 * 判断放在这里，就能在点之前把原因说清楚（而不是点完弹一个"失败"）。
 */

/** 改名要用的文案（逐字取自证据）。 */
export const RENAME_LABELS = {
  /** `drive_menuOption_rename` / `drive_rename_header` */
  title: "重命名",
  /** `drive_rename_btn_rename` */
  ok: "确认",
  /** `drive_rename_btn_cancel` */
  cancel: "取消",
  /** `drive_toast_nameEmpty` */
  empty: "名称不能为空",
} as const;

/** 一份文件的文本上限（超过就不往阅读器里塞 —— 界面会卡住）。 */
export const READ_MAX_BYTES = 200 * 1024;

/** 能不能读成文本（按类目判断，二进制类型不硬读）。 */
export function isTextKind(kind: string): boolean {
  return kind === "doc" || kind === "code" || kind === "canvas" || kind === "sheet";
}

/** 改名的判断结果。 */
export type RenamePlan = { ok: true; name: string } | { ok: false; reason: string };

/**
 * 判断这次改名行不行。
 *
 * ⚠️ 三种情况要**在点之前**分开说清，而不是统一报"失败"：
 * - 空的 → 「名称不能为空」（证据里那句）
 * - 有路径分隔符 → 文件系统会把它当目录，必须挡（否则能写到云盘目录外面）
 * - **已经在用的名字** → 直接说"已经有同名文件了"（**不覆盖**；覆盖是不可逆的）
 *
 * @param current 现在叫什么
 * @param input 用户输入的新名字
 * @param existing 该目录里已有的名字（含原名自己）
 * @returns 通过则给出最终名字（**去掉首尾空白**）
 */
export function planRename(current: string, input: string, existing: readonly string[]): RenamePlan {
  const name = input.trim();
  if (!name) return { ok: false, reason: RENAME_LABELS.empty };
  if (/[\\/]/.test(name)) return { ok: false, reason: "名称里不能有路径分隔符" };
  if (name.length > 80) return { ok: false, reason: "名称太长了（最多 80 字）" };
  // 改成自己原来的名字 = 什么也不用做（不算错，别弹失败）
  if (name === current) return { ok: true, name };
  /*
   * 重名判断**不区分大小写**：Windows 上 `A.md` 与 `a.md` 是同一个文件，
   * 而"改成只有大小写不同的名字"在 Windows 上会被文件系统直接拒掉 ——
   * 这里先说清，别让它变成一个看不懂的系统错误。
   */
  const lower = name.toLowerCase();
  if (existing.some((x) => x.toLowerCase() === lower)) {
    return { ok: false, reason: "已经有同名文件了，换个名字" };
  }
  return { ok: true, name };
}
