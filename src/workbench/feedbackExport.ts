import type { ShellBridge } from "@shared/ipc";

/**
 * 诊断包导出（2026-10-17，V5 开工前清尾 §2.4 #7）——「反馈」那颗死控件的真归宿。
 *
 * 本机版**没有上报服务端**（也不该有：本地主权）。反馈通道的本地形态就是导出一个
 * 诊断包（自检结果 + 版本/路径，**不含任何密钥值**），用户自己把它交给能帮上忙的人。
 * 主进程那半在 `electron/ipc/diagnostics.ts`（自检项复用 `engine/runtime/doctor.ts`）。
 *
 * 回归：`feedbackExport.test.ts`（桥四种状态）、`src/diagnosticsExport.test.ts`（主进程侧，
 * 含"密钥值不许进包"那条）。
 */

type Outcome = { ok: true; message: string } | { ok: false; message: string };

/**
 * 导出诊断包（写盘 + 在文件管理器里定位都发生在主进程）。
 *
 * @returns 一句能直接显示给用户的话（成功带真实路径；失败带原因 —— 从不静默）
 */
export async function exportDiagnosticsPackage(): Promise<Outcome> {
  const shell = (globalThis as unknown as { shell?: ShellBridge }).shell;
  if (typeof shell?.diagnostics?.export !== "function") {
    return { ok: false, message: "诊断包导出需要在应用里运行（当前环境没有主进程）" };
  }
  try {
    const got = await shell.diagnostics.export();
    if (!got.ok) return { ok: false, message: got.error };
    return { ok: true, message: `诊断包已导出并定位：${got.path}` };
  } catch (error) {
    return { ok: false, message: `诊断包导出失败：${error instanceof Error ? error.message : String(error)}` };
  }
}

/**
 * 「反馈」这条命令的**整套动作**：导出 → 用宿主给的提示条说一句。
 *
 * ⚠️ 组合放在这里而不是界面里：`Composer.tsx` 已经贴着结构守卫的 900 行上限，
 * 而"导出完必须说话"（成功带真实路径、失败带原因）是这条命令的语义，
 * 写在拥有它的模块里，界面那一行只管调它。
 */
export function runFeedbackCommand(show: (text: string) => void): void {
  void exportDiagnosticsPackage().then((got) => show(got.message));
}
