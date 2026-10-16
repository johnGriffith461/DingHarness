/**
 * 会**自己消失**的提示条（2026-10-16，审计 P91）。
 *
 * ## 原来错在哪
 *
 * 这种提示在仓里是**裸发定时器**的写法：
 *
 * ```ts
 * setMaterialNote("加了 3 个文件");
 * window.setTimeout(() => setMaterialNote(""), 4000);
 * ```
 *
 * 三个毛病一起：
 *   ① **互相踩踏** —— 4 秒内又操作一次（提示条换了新话），前一个定时器到点把**新话**擦掉
 *      （用户看到提示一闪而过，以为没生效）；
 *   ② **卸载后照样跑** —— 面板关了、页面切了，回调仍然去 `setState`；
 *   ③ 句柄没人存，想清也清不了。
 *
 * ## 现在怎么判
 *
 * `show(text)` 先清上一个定时器再挂新的：**后一条提示永远活够它自己的时间**；
 * 卸载时（effect 清理）把定时器撤掉。
 *
 * 写成 hook 是因为它在仓里有七处（Composer / PluginsPage / ReaderPanel）——
 * 一份实现，别各写各的（那是这轮审计反复点的那类毛病）。
 */

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * 一条"说完自己消失"的提示。
 *
 * @param ttlMs 显示多久（默认 3 秒）
 * @returns `[当前提示, 说一句]`
 */
export function useTransientNote(ttlMs = 3000): [string, (text: string) => void] {
  const [note, setNote] = useState("");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clear = useCallback(() => {
    if (timer.current !== null) {
      clearTimeout(timer.current);
      timer.current = null;
    }
  }, []);

  const show = useCallback(
    (text: string) => {
      /* 先清旧的：否则前一条的定时器会把这一条提前擦掉 */
      clear();
      setNote(text);
      if (!text) return;
      timer.current = setTimeout(() => {
        timer.current = null;
        setNote("");
      }, ttlMs);
    },
    [clear, ttlMs],
  );

  /* 卸载时撤掉定时器（关面板之后还去 setState 是另一个毛病） */
  useEffect(() => clear, [clear]);

  return [note, show];
}

/**
 * 一次性标记（`setSaved(true)` 之后 1.5 秒落回 false 那种）。
 *
 * 与 `useTransientNote` 同一套判据，只是状态是个布尔。
 *
 * @param ttlMs 保持多久
 * @returns `[当前是不是亮着, 点亮一下]`
 */
export function useTransientFlag(ttlMs = 1500): [boolean, () => void] {
  const [on, setOn] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clear = useCallback(() => {
    if (timer.current !== null) {
      clearTimeout(timer.current);
      timer.current = null;
    }
  }, []);

  const pulse = useCallback(() => {
    clear();
    setOn(true);
    timer.current = setTimeout(() => {
      timer.current = null;
      setOn(false);
    }, ttlMs);
  }, [clear, ttlMs]);

  useEffect(() => clear, [clear]);

  return [on, pulse];
}
