/**
 * 「从本机添加资料」的结果解析（2026-10-14）。
 *
 * ## 为什么单独一个纯模块
 * 这条链上有一个**没法自动化**的环节：原生文件对话框（`dialog.showOpenDialog` 是模态的，
 * CDP 驱动不了）。所以把**它之外**的部分抽出来 —— "导入结果 + 云盘清单 → 要附着哪些文件" ——
 * 这一段有真实的坑（重名被加序号、清单里认不回路径、失败原因要如实回报），
 * 完全可以被单测钉住。
 *
 * ## 一个绕不开的接口事实
 * `drive:import` 只回 **名字与成败**（`ImportItem`：`{name, ok, reason?, savedAs?}`），
 * **不回路径** —— 而附着/读取都要绝对路径。所以这里从云盘清单（`drive:list`，它带 `path`）
 * 按名字把路径认回来：
 *   · 正常情况用 `savedAs`（重名时主进程会加序号，`savedAs` 才是落盘后的真名）；
 *   · `savedAs` 缺失时才退回原文件名；
 *   · **认不回来的一律如实归入"没进来"**，不静默丢掉。
 */

/** 与主进程 `ImportItem` 形状对齐（失败项没有 `path`）。 */
export type ImportedItem = {
  name: string;
  ok: boolean;
  reason?: string;
  savedAs?: string;
};

/** 云盘清单里的条目（只要名字与路径就够）。 */
export type DriveListEntry = { name: string; path: string };

/** 解析结果。 */
export type ImportResolution = {
  /** 认回来的文件（可直接附着/读取）。 */
  picked: Array<{ name: string; path: string }>;
  /** 主进程说没进来的（名字 + 原因）。 */
  rejected: Array<{ name: string; reason: string }>;
  /** 清单里认不回路径的（进来了但找不到）——**单独一类**，不混进 rejected。 */
  unmatched: string[];
};

/**
 * 把一次导入的结果解析成"能附着的东西"。
 *
 * @param items 主进程回报的逐文件结果
 * @param entries 导入之后重新拉到的云盘清单（要带 `path`）
 * @returns 认回来的 / 被拒的 / 认不回来的
 */
export function resolveImportedMaterials(
  items: readonly ImportedItem[],
  entries: readonly DriveListEntry[],
): ImportResolution {
  const pathByName = new Map(entries.map((e) => [e.name, e.path]));
  const picked: ImportResolution["picked"] = [];
  const rejected: ImportResolution["rejected"] = [];
  const unmatched: string[] = [];

  for (const item of items) {
    if (!item.ok) {
      rejected.push({ name: item.name, reason: item.reason ?? "parseFail" });
      continue;
    }
    const savedName = item.savedAs ?? item.name;
    const path = pathByName.get(savedName);
    if (path) picked.push({ name: savedName, path });
    else unmatched.push(savedName);
  }
  return { picked, rejected, unmatched };
}
