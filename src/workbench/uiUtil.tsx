/**
 * 从 `Workbench.tsx` 拆出来的（C6-1）。**纯挪位**：一个字没改，只加了 export 与 import。
 * 拆的理由原本记在 `docs/PLAN-C6-结构拆分.md`：那个文件 2188 行、14 个顶层组件，
 * ⚠️（该依据未入库、本机也找不到 —— 决策链断在这里，无法复核；以本文件里的断言与实现为准）
 * 改一处要读两千行 —— 于是「顺手加一行」变成默认做法。
 */

/*
 * ⚠️ 这一条 import 是**手工补的**：切片脚本给这个文件算出"没有一条 import 用得上"
 * （它把跨文件的引用算漏了），于是 `PERMISSION_MODES` 没了、`CONFIRM_MODES` 悬空。
 * 原本记在 `docs/PLAN-C6-结构拆分.md`：自动搬运只保证"**删掉 + 挪走**"两种 diff，
 * **import 的正确性由 `tsc` 兜底** —— 这一步就是被 tsc 抓出来的。
 */
import { CONFIRM_MODES as PERMISSION_MODES } from "@shared/ipc";

export function setNoteIfAny(message: string): void {
  const el = document.querySelector('[data-testid="wb-project-name"]') as HTMLInputElement | null;
  if (el) {
    el.setCustomValidity(message);
    el.reportValidity();
    el.setCustomValidity("");
  }
}

/* ============================================================
 * 澄清提问卡
 * ============================================================ */


export function PenIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />
    </svg>
  );
}

/* ============================================================
 * 输入区（对标原版：项目 / 按需确认 / 技能 / 插件 / 模型 / 麦克风）
 *
 * 原版的「环境选择器」已按用户要求删掉 —— 默认就是本地电脑，
 * 没有可选项时留着一个点了没用的 chip 不如不留。
 * ============================================================ */

/*
 * 三个档位的文案与判定**同源**（词表 `@shared/ipc`、判定 `@engine/core/policy`）——
 * 原来这里自己写了一份 `CONFIRM_MODES`，而"判定"要用的也是同一张表：
 * 两处各写一份的话，改文案不会改到判定（本项目栽过多次的形态）。
 *
 * 默认值是「全部允许」：依据本体首页实机截图，输入区那一格显示的就是它。
 * （原来默认写的「按需确认」是我推的，不是本体的口径。）
 */
export const CONFIRM_MODES = PERMISSION_MODES;


/**
 * 往剪贴板写一段文字，**返回真的写成了没有**（2026-10-16，审计 P86）。
 *
 * 为什么不能是 `void navigator.clipboard.writeText(text)`：那种写法不 await、不 catch，
 * 剪贴板被占用 / 没有权限（远程桌面、某些安全软件、自动化驱动下都常见）时，
 * 界面照样说"已复制"，而用户粘出来是旧内容或者空的 —— **回执先于结果**。
 *
 * 另外浏览器策略也在这一层：非用户手势触发的写入会 reject，那同样算"没写成"，照实说。
 *
 * @param text 要写的内容
 * @returns 真的写进剪贴板了吗
 */
export async function writeClipboard(text: string): Promise<boolean> {
  try {
    const clip = navigator.clipboard;
    if (!clip?.writeText) return false;
    await clip.writeText(text);
    return true;
  } catch {
    return false;
  }
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * 「图片与视频」tab —— **真实画廊**。
 *
 * 数据来自云盘那三个真实目录（产物 / 导出 / 云盘本体）里扩展名属于图片的文件。
 * 缩略图走 `dshasset://file/<origin>/<名字>`（这一档走 path 而不是 host，
 * 因为 standard 协议会把 host 小写化，中文文件名会取不到）。
 *
 * 视频这一类在本机是空的 —— 不是没做，而是**这个 Key 下一个视频模型都没有**，
 * 界面上如实写明。
 */
