/**
 * **知识库的 IPC 形状**（G15 桌面面板）。
 *
 * 结构照 `engine/rag/store.ts` 的 `KnowledgeDoc` / `KnowledgeHit`，但**不 import engine**
 * （`shared` 不依赖内核，见 AGENTS.md）。两边字段由 `src/knowledgeIpc.test.ts` 对账 ——
 * 抄一份形状就必须有一条守卫盯着，否则引擎加一个字段界面永远看不到。
 */

export type KnowledgeDomainWire = "private" | "team";

export type KnowledgeDocWire = {
  id: string;
  path: string;
  title: string;
  domain: KnowledgeDomainWire;
  owner: string;
  bytes: number;
  addedAt: number;
  /** 切成了几段（0 = 内容为空，检索不到）。 */
  chunks: number;
};

export type KnowledgeHitWire = {
  docId: string;
  path: string;
  title: string;
  domain: KnowledgeDomainWire;
  ordinal: number;
  text: string;
  score: number;
  /** 给人/模型看的引用（标题 + 路径 + 第几段）。 */
  citation: string;
};

/** 加一段文字（面板里的"粘贴一段"）。 */
export type KnowledgeAddTextInput = {
  title: string;
  text: string;
  domain?: KnowledgeDomainWire;
};

/** 加文件的结果（取消也要说清，不能与"失败"混成同一个空返回值）。 */
export type KnowledgeAddFileResult =
  | { ok: true; doc: KnowledgeDocWire; path: string }
  | { ok: false; canceled?: boolean; error?: string };

/** `ShellBridge.knowledge` 的形状（放在这里，`shared/ipc.ts` 只剩一行引用）。 */
export type KnowledgeBridge = {
  list: () => Promise<{ docs: KnowledgeDocWire[]; file: string }>;
  addText: (
    input: KnowledgeAddTextInput,
  ) => Promise<{ ok: true; doc: KnowledgeDocWire; replaced: boolean } | { ok: false; error: string }>;
  addFile: () => Promise<KnowledgeAddFileResult>;
  search: (query: string) => Promise<{ hits: KnowledgeHitWire[] }>;
  remove: (idOrPath: string) => Promise<{ removed: number }>;
};
