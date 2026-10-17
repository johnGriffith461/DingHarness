import fs from "node:fs";
import path from "node:path";

/**
 * **中途插话队列**（G06 的 steer 那一半，2026-10-18）。
 *
 * ## 它解决什么
 *
 * 长任务跑到第 5 步时用户想补一句（"别改测试，只改实现"），
 * 而这一轮已经在跑 —— 没有插话通道的话，只能等它跑完，而那时错已经犯完了。
 *
 * ## 形态：**文件队列 + 步骤边界投递**
 *
 * - CLI：`ding steer <会话 id> "话"` 把话写进 `<数据目录>/steer/<会话>.jsonl`；
 * - 跑着的那一轮在**每一步之间**（AI SDK 的 `prepareStep`）读一次队列，
 *   有就作为一条 `user` 消息插进上下文，并把它记成事件（用户看得见它生效了）。
 * - 投递即出队（同一条话不会在下一步再插一次）。
 *
 * ## 三条边界
 *
 * 1. **只在步骤边界投递**：不打断正在生成的那一步 —— 那会变成"半句话被截断"，
 *    上下文里留下一个残句。
 * 2. **投递失败不丢**：读/写坏了只会让这一步**没插上**，下一轮还能再送；
 *    不静默删掉用户的输入。
 * 3. **同一会话一个队列**（文件名由会话 id 洗过）—— 不同会话的话不会串味。
 */

/** 队列目录（`<dataDir>/steer`）。 */
export const STEER_DIR = "steer";

/** 把会话 id 洗成安全的文件名（它会变成路径的一段）。 */
export function steerFileName(sessionId: string): string {
  /* 去掉开头的点：`..` 这类名字虽然拼出来是一个文件名，但不该出现在任何路径片段里 */
  const safe = String(sessionId ?? "")
    .replace(/[^\w.-]+/g, "_")
    /* 连续的点点一律压成一个下划线：文件名里出现 `..` 只会让人怀疑路径穿越 */
    .replace(/\.{2,}/g, "_")
    .replace(/^\.+/, "")
    .slice(0, 120);
  return `${safe || "session"}.jsonl`;
}

/** 队列文件路径。 */
export function steerPath(dataDir: string, sessionId: string): string {
  return path.join(dataDir, STEER_DIR, steerFileName(sessionId));
}

/**
 * 投递一条插话（追加写，**不覆盖**）。
 *
 * @param dataDir 数据目录
 * @param sessionId 会话
 * @param text 用户的话
 * @param now 时间（测试用）
 */
export function enqueueSteer(dataDir: string, sessionId: string, text: string, now: number = Date.now()): boolean {
  const body = String(text ?? "").trim();
  if (!body) return false;
  try {
    const file = steerPath(dataDir, sessionId);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${JSON.stringify({ at: now, text: body })}\n`, "utf8");
    return true;
  } catch {
    return false;
  }
}

/**
 * 取走队列里的全部插话（读 + 清空）。
 *
 * ⚠️ 先读后清：清空用写空文件而不是删除 —— 删除会让 "文件不存在" 与
 * "队列本来就是空的" 变成同一件事，排错时分不清。
 *
 * @param dataDir 数据目录
 * @param sessionId 会话
 * @returns 插话文本（按投递顺序）
 */
export function drainSteer(dataDir: string, sessionId: string): string[] {
  const file = steerPath(dataDir, sessionId);
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const texts: string[] = [];
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      const parsed = JSON.parse(t) as { text?: unknown };
      if (typeof parsed.text === "string" && parsed.text.trim()) texts.push(parsed.text.trim());
    } catch {
      /* 坏行跳过（写入被打断）—— 但它已经不在文件里了，下一轮不会再送 */
    }
  }
  try {
    fs.writeFileSync(file, "", "utf8");
  } catch {
    /* 清不掉就把话留着：宁可下一步重复一次，也别丢掉用户的输入 */
  }
  return texts;
}

/** 队列里还有几条（`ding steer` 用来确认写进去了）。 */
export function pendingSteer(dataDir: string, sessionId: string): number {
  try {
    return fs
      .readFileSync(steerPath(dataDir, sessionId), "utf8")
      .split("\n")
      .filter((line) => line.trim()).length;
  } catch {
    return 0;
  }
}
