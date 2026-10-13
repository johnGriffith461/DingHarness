/** 只在下一帧执行一次；同一帧内多次调用只跑最后一次。 */
export function rafThrottle<Args extends unknown[]>(
  fn: (...args: Args) => void,
): (...args: Args) => void {
  let scheduled = false;
  let last: Args | null = null;

  return (...args: Args) => {
    last = args;
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      const call = last;
      last = null;
      if (call) fn(...call);
    });
  };
}
