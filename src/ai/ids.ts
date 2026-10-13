/**
 * 会话里的 id 生成器（从 `chatStore.ts` 抽出来）。
 *
 * ⚠️ **必须是同一个计数器**：恢复历史（`chatRestore.ts`）与实时发送
 * （`chatStore.ts`）都造消息 id，而 id 是 React 的 key、也是「重试」找那条消息的依据。
 * 两处各带一个计数器的话，同一毫秒里造出来的 id 会**撞车** ——
 * 表现是"点了重试动的是另一条消息"，极难查。
 */
let seq = 0;

/** 造一个 `前缀-时间戳-序号` 的 id。 */
export const nextId = (prefix: string): string => `${prefix}-${Date.now()}-${(seq += 1)}`;
