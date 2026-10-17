import fs from "node:fs";
import path from "node:path";

import type { SpillPort, SpillWriteResult } from "../ports/spill";
import { SPILL_TTL_DAYS } from "../runtime/spill";

/**
 * 工具结果落盘的**文件实现**（U02，2026-10-18）。
 *
 * 落点：`<dataDir>/tool-results/<toolCallId>.txt`。
 *
 * ## 文件名为什么只用 `toolCallId`
 *
 * 它是模型给的那次调用的 id，天然唯一。**不**把工具名或用户路径拼进文件名：
 * 那些是不可信输入，拼进来就要处理 `..` / 非法字符 / 大小写冲突 —— 而这里
 * 根本不需要可读的文件名（文件头已经写了工具名与时间）。
 *
 * ## 为什么写入前先清理
 *
 * 长任务会产出成百上千份落盘结果。清理放在**写入时**（每次顺手扫一遍）而不是
 * 启动时一次：CLI 的进程活几分钟就退，桌面可能几周不重启 —— 只有"写入时"
 * 这个时刻在两种宿主里都一定会发生。
 *
 * ## 一个已知边界（如实写）
 *
 * 这里**不**做配额（最多占多少 MB）。TTL 7 天已经能兜住绝大多数情况；
 * 真要做配额得先有"用户能看见并清理"的入口，否则就是悄悄删证据。
 */

/** 落盘目录名（`dataDir` 下面这一层）。 */
export const SPILL_DIR_NAME = "tool-results";

/** 把任意 toolCallId 洗成一个安全的单段文件名。 */
export function safeSpillName(toolCallId: string): string {
  const cleaned = String(toolCallId ?? "").replace(/[^\w.-]+/g, "_").replace(/^\.+/, "");
  return `${cleaned || "call"}.txt`;
}

/**
 * 建一个文件落盘端口。
 *
 * @param dataDir 宿主的数据目录（CLI 是 `~/.ding`，桌面是 `userData`）
 * @param now 现在（测试用）
 */
export function createFileSpillStore(dataDir: string, now: () => number = Date.now): SpillPort {
  const dir = path.join(dataDir, SPILL_DIR_NAME);

  /** 清掉超过 TTL 的文件；失败不抛（清理不该让工具失败）。 */
  const cleanup = (): void => {
    let entries: string[];
    try {
      entries = fs.readdirSync(dir);
    } catch {
      return;
    }
    const cutoff = now() - SPILL_TTL_DAYS * 86_400_000;
    for (const name of entries) {
      const full = path.join(dir, name);
      try {
        if (fs.statSync(full).mtimeMs < cutoff) fs.rmSync(full, { force: true });
      } catch {
        /* 单个文件清不掉就跳过 —— 下次再试 */
      }
    }
  };

  return {
    dir,
    async write({ toolCallId, toolName, text }): Promise<SpillWriteResult> {
      fs.mkdirSync(dir, { recursive: true });
      cleanup();
      const file = path.join(dir, safeSpillName(toolCallId));
      const header = [
        `# ${toolName} 的完整输出`,
        `# 落盘时间：${new Date(now()).toISOString()}`,
        `# 说明：这份文件由 Ding Harness 自动保存（${SPILL_TTL_DAYS} 天后清理）。`,
        "",
      ].join("\n");
      fs.writeFileSync(file, header + text, "utf8");
      const bytes = Buffer.byteLength(text, "utf8");
      const lines = text === "" ? 0 : text.split("\n").length;
      return { path: file, bytes, lines };
    },
  };
}

/**
 * 这个路径是不是落在落盘目录里（`read_file` 回读用）。
 *
 * 判据与 `insideDirs` 同一口径：按真实路径比，符号链接不能穿墙。
 * 单独一个函数是因为它只有**一个**允许根，而 `insideDirs` 收数组 ——
 * 直接用同一个实现，别在这里另写一份 `startsWith`。
 *
 * @param raw 模型给的路径
 * @param dir 落盘目录
 */
export function insideSpillDir(raw: string, dir: string): string | null {
  const resolved = path.resolve(String(raw ?? ""));
  let real: string;
  try {
    real = fs.realpathSync.native(resolved);
  } catch {
    /* 文件还不存在（或路径坏）→ 用字面解析结果比对；真正的读写会再失败一次 */
    real = resolved;
  }
  let realDir: string;
  try {
    realDir = fs.realpathSync.native(path.resolve(dir));
  } catch {
    realDir = path.resolve(dir);
  }
  const rel = path.relative(realDir, real);
  if (rel.startsWith("..") || path.isAbsolute(rel)) return null;
  return resolved;
}
