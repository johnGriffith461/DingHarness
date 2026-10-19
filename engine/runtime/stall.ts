/**
 * P0-06：卡住检测（重复调用与无进展）。
 *
 * ## 为什么需要它
 *
 * 模型有时会陷入"同一个调用、同样的参数、同样的报错"的循环 —— 每一步都在花钱，
 * 却没有任何进展。Crush 的 `loop_detection.go`、Cline 的 soft 3 / hard 5、
 * OpenHands 的 `stuck_detector.py` 都在做同一件事。
 *
 * 口径（与方案一致）：
 * - 最近 10 步里同一签名出现 **3 次** → 提示一句；
 * - 出现 **5 次** → 停止这一轮，如实报"没有进展"。
 */

/** 一次判定。 */
export type StallVerdict = "ok" | "nudge" | "stop";

/** 提示模型换方法的那句话（界面也显示同一句）。 */
export const STALL_NUDGE =
  "你已经在重复同一个工具调用（同样的参数）。停下来换一种方法，或者说明卡在哪、需要什么信息。";

/** 判定停止时给用户的那句话。 */
export const STALL_STOPPED = "检测到重复调用，已停止（没有进展）";

/** 稳定 JSON：对象键排序、递归处理数组与嵌套对象。 */
function stable(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  const o = value as Record<string, unknown>;
  return `{${Object.keys(o)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stable(o[k])}`)
    .join(",")}}`;
}

/**
 * 工具调用的签名：名字 + 参数（键顺序无关）。
 *
 * 同样两个参数换个键顺序是**同一次调用**，不能因为序列化差异被判成两次。
 */
export function signatureOf(name: string, input: unknown): string {
  return `${name}:${stable(input ?? null)}`;
}

export type StallDetector = {
  /** 记一次调用，返回该怎么处理。 */
  push(signature: string): StallVerdict;
  /** 这一轮见过的调用签名数（测试/调试用）。 */
  seen(): number;
};

/**
 * 建一个检测器。
 *
 * @param opts.window 只看最近多少步（默认 10）
 * @param opts.nudgeAt 同一签名出现几次开始提示（默认 3）
 * @param opts.stopAt 同一签名出现几次停止（默认 5）
 */
export function createStallDetector(opts: { window?: number; nudgeAt?: number; stopAt?: number } = {}): StallDetector {
  const window = Math.max(2, Math.floor(opts.window ?? 10));
  const nudgeAt = Math.max(2, Math.floor(opts.nudgeAt ?? 3));
  const stopAt = Math.max(nudgeAt + 1, Math.floor(opts.stopAt ?? 5));
  const recent: string[] = [];
  /** 同一签名只提示一次（提示过之后还继续，就到 stop） */
  const nudged = new Set<string>();
  return {
    push(signature: string): StallVerdict {
      recent.push(signature);
      if (recent.length > window) recent.shift();
      const count = recent.filter((s) => s === signature).length;
      if (count >= stopAt) return "stop";
      if (count >= nudgeAt && !nudged.has(signature)) {
        nudged.add(signature);
        return "nudge";
      }
      return "ok";
    },
    seen: () => recent.length,
  };
}

/** 空响应的结局：模型什么都没说、也没调工具。 */
export function emptyResponseOutcome(): { ok: false; error: string } {
  return { ok: false, error: "模型没有返回任何内容" };
}
