/**
 * 朗读音色（阶段 11.31）。
 *
 * 「声音选择」这一行原来是**死按钮**（点它什么都不发生）。而「朗读」那一步
 * 我已经接成真的了（`speechSynthesis`），所以这条闭环本地完全做得了：
 * 选一个系统音色 → 朗读用它 → 记住选择。
 *
 * 放在 `localStorage` 而不是主进程：音色是**这台机器的浏览器**提供的，
 * 换个用户/换台机器本来就该重新选，没有跨设备同步的意义。
 */

const VOICE_KEY = "dsh-canvas.tts-voice";

/**
 * 取已选的音色名。
 *
 * @returns 音色名；没选过返回空串（= 用系统默认）
 */
export function readVoiceName(): string {
  try {
    return localStorage.getItem(VOICE_KEY) ?? "";
  } catch {
    return "";
  }
}

/**
 * 记住选的音色。
 *
 * @param name 音色名；给空串表示恢复系统默认
 */
export function saveVoiceName(name: string): void {
  try {
    if (name) localStorage.setItem(VOICE_KEY, name);
    else localStorage.removeItem(VOICE_KEY);
  } catch {
    /* 存不下就算了：这次朗读仍然按内存里的选择走 */
  }
}

/**
 * 列出这台机器上可用的音色。
 *
 * ⚠️ Chromium 的 `getVoices()` **第一次调用常常是空的** —— 音色列表是异步取回来的。
 * 所以要听 `voiceschanged`；只听一次会得到"没有可选音色"的错觉。
 *
 * @param onChange 音色列表变化时的回调（返回取消订阅函数）
 * @returns 当前已取到的音色列表（可能为空，随后由回调补齐）
 */
export function listVoices(onChange: (voices: SpeechSynthesisVoice[]) => void): () => void {
  const synth = typeof window !== "undefined" ? window.speechSynthesis : undefined;
  if (!synth) {
    onChange([]);
    return () => undefined;
  }
  const pick = () => onChange(synth.getVoices());
  pick();
  synth.addEventListener("voiceschanged", pick);
  return () => synth.removeEventListener("voiceschanged", pick);
}

/**
 * 从列表里按名字找音色。
 *
 * @param voices 候选
 * @param name 要用的名字
 * @returns 找到的音色；找不到给 `null`（**不瞎选一个**，否则用户会以为设置没生效）
 */
export function findVoice(
  voices: SpeechSynthesisVoice[],
  name: string,
): SpeechSynthesisVoice | null {
  if (!name) return null;
  return voices.find((v) => v.name === name) ?? null;
}
