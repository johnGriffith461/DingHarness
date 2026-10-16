/**
 * 节点编辑态的落盘口径（2026-10-16 审计 P27 / P28）。
 *
 * ## 两条缺陷的公共形状
 *
 * 形状文字、HTML 源码、白板的笔迹**都只在"某个事件"时才写回 store**
 * （blur、抬笔后 500ms 的定时器）—— 而节点可能在那之前**卸载**：
 *   · `CanvasRuntime` 开着 `onlyRenderVisibleElements`，滚出视野的节点会被卸下来；
 *   · 画布面板一关，整块画布卸载。
 * 于是"打了一半的字 / 刚抬笔的最后几笔"**只存在于组件内部**，卸载即丢；
 * 而且白板那份还挡着外部同步（`dirtyRef` 为真时不接受外部笔迹），
 * 叠上撤销/重做就更容易看出来"笔画没了"。
 *
 * ## 这里装什么
 *
 * 两件框架无关的小东西，让上面那些组件能用**同一份**口径：
 *   · `createEditBuffer` —— "有未提交的改动吗 / 提交一次 / 卸载时提交"，
 *     顺带解决"提交两次"（blur 与卸载都会调它）；
 *   · `shouldCommitOnEnter` —— 回车提交的判据，**IME 组合态里不许提交**
 *     （中文输入法里选词的回车会被当成"确认"：一句话被切成好几段，或者拼音原文被写进内容）。
 */

/**
 * 编辑缓冲：拿着"正在编辑的值"，负责"什么时候把它交出去"。
 *
 * ⚠️ 它只认**值**，不认时间 —— 白板那边原来靠一个 500ms 的定时器（`SYNC_DEBOUNCE_MS`），
 * 那个窗口里卸载就丢笔画；把"交出去"这一步收在这里之后，
 * 卸载时调 `flush()` 与定时器到点调 `flush()` 是**同一件事**，不会再有一条路漏掉。
 */
export type EditBuffer = {
  /** 记下正在编辑的值（每次 onChange 调）。 */
  set: (value: string) => void;
  /** 有还没提交的改动吗。 */
  dirty: () => boolean;
  /** 待提交的值（没改过时 undefined）。 */
  pending: () => string | undefined;
  /**
   * 提交一次。
   *
   * **幂等**：没改动、或已经提交过同一个值，都不会再打一次 `commit`
   *（blur 与卸载会连着调它，重复提交会让撤销栈里多一条空的）。
   */
  flush: () => void;
  /** 外部值变了（载入 / 撤销换快照）：把比较基准换成它。 */
  reset: (committed: string) => void;
};

/**
 * 造一个编辑缓冲。
 *
 * @param commit 真正写回 store 的动作
 */
export function createEditBuffer(commit: (value: string) => void): EditBuffer {
  /** 已提交（= 外部那一份）的值；`null` = 还没有基准（这时任何 draft 都算未提交）。 */
  let committed: string | null = null;
  let draft: string | null = null;
  return {
    set: (value) => {
      draft = value;
    },
    /* 没有基准时也算"脏"：宁可多写一次（幂等），也不能因为"不知道基准"就把用户打的东西丢了 */
    dirty: () => draft !== null && draft !== committed,
    pending: () => {
      if (draft === null) return undefined;
      return draft === committed ? undefined : draft;
    },
    flush: () => {
      const value = draft;
      if (value === null) return;
      if (value === committed) return;
      committed = value;
      commit(value);
    },
    reset: (value) => {
      committed = value;
      draft = null;
    },
  };
}

/** 键盘事件里与"回车提交"有关的部分。 */
export type EnterLike = {
  key: string;
  shiftKey: boolean;
  /** IME 组合态：`KeyboardEvent.isComposing`（浏览器都给了，不用去数 keyCode 229）。 */
  isComposing?: boolean;
};

/**
 * 这一下回车该不该提交。
 *
 * ⚠️ `isComposing` 必须挡掉（P27 的 IME 那一半）：中文/日文输入法里，
 * "回车选词"也是一次 keydown Enter —— 不挡的话用户打一句中文会被**中途确认好几次**，
 * 撤销栈里多出一串，内容也可能停在拼音阶段。
 *
 * @param event 键盘事件
 * @returns true = 提交
 */
export function shouldCommitOnEnter(event: EnterLike): boolean {
  if (event.key !== "Enter") return false;
  if (event.isComposing) return false;
  // Shift+Enter 是换行（形状文字是多行输入）
  return !event.shiftKey;
}
