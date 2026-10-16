import { create } from "zustand";
import type { ShellBridge } from "@shared/ipc";
import {
  DOC_ACTION_LABEL,
  applyDocEdit,
  docTitle,
  docActionInstruction,
  defaultExportName,
  makeDoc,
  normalizeDocs,
  restoreDocVersion,
  type Doc,
  type DocAction,
} from "@shared/doc";
import { completeOnce } from "@/ai/aiClient";
import { DOC_BAR_LABELS, DOC_CREATE_LABELS, attachmentLink, docFromMessage, insertAt } from "@shared/doc";
import {
  DOC_FORMAT_LABEL,
  DOC_TONE_LABEL,
  applyFormat,
  toneInstruction,
  type DocFormat,
  type DocTone,
  type TextRange,
} from "@shared/docFormat";
import { NO_ROUTE_MESSAGE, resolveChatRoute } from "@/ai/route";

/**
 * AI 文档的状态（§153）。
 *
 * ## 契约
 *
 * - **磁盘是权威**：改动先落到本地 state（界面立刻响应），再**延迟落盘**（400ms）；
 *   重开应用后以磁盘为准。
 * - 读回来的一律过 `normalizeDocs`（磁盘不可信）。
 * - 操作条（缩写/扩写/润色/总结概括）走**真模型调用**，结果**整篇替换正文**并把旧内容推进历史。
 */

const bridge = (): ShellBridge | undefined => (globalThis as unknown as { shell?: ShellBridge }).shell;

let seq = 0;
function nextDocId(): string {
  seq += 1;
  return `doc_${Date.now().toString(36)}_${seq}`;
}

type DocState = {
  docs: Doc[];
  loaded: boolean;
  /** 当前打开的那一篇（null = 面板关着）。 */
  activeId: string | null;
  /** 操作条正在跑（界面显示「撰写中...」）。 */
  busy: boolean;
  /** 一次性提示（复制成功之类）。 */
  note: string;

  load: () => Promise<void>;
  open: (id: string) => void;
  close: () => void;
  /** 新建一篇并打开它。 */
  create: () => Promise<string>;
  /** 改标题 / 正文（用户手改走这里，reason 写进历史）。 */
  patch: (id: string, patch: { title?: string; body?: string }, reason: string) => void;
  /** 回到某个历史版本。 */
  restore: (id: string, v: number) => void;
  /** 跑一个操作条动作（真调模型）。 */
  /**
   * 从一段文本创建文档（§172，「创建文档」）。
   *
   * @returns 新文档 id；文本是空的给 `null`（界面据此说"文档创建失败"）
   */
  createFromText: (text: string) => Promise<string | null>;
  /**
   * 把剪贴板里的文字粘贴到选区（§173）。
   *
   * @returns 粘进去没有（剪贴板空的时候界面要说一句，不能点了没反应）
   */
  pasteInto: (id: string, range?: TextRange) => Promise<boolean>;
  /**
   * 把一个云盘文件当附件插进文档（§173）—— 插的是一条 Markdown 链接。
   */
  attachTo: (id: string, range: TextRange | undefined, entry: { name: string; origin: string }) => void;
  runAction: (id: string, action: DocAction) => Promise<void>;
  /** 调整语气（§168）：这一档走模型（语气是"表达方式"，本地改不了）。 */
  runTone: (id: string, tone: DocTone) => Promise<void>;
  /**
   * 调整格式（§168）：**纯本地**，瞬时（给小标题加 `##` 这种事不需要模型）。
   *
   * @param range 选区；省略则整篇
   */
  applyFormatTo: (id: string, kind: DocFormat, range?: TextRange) => void;
  /** 导出成文件（走产物的落盘通道）。 */
  exportDoc: (id: string) => Promise<string>;
  remove: (id: string) => Promise<void>;
  clearNote: () => void;
};

/** 延迟落盘：连续打字不该每一键都写一次文件。 */
let saveTimer: ReturnType<typeof setTimeout> | null = null;

export const useDocStore = create<DocState>()((set, get) => {
  const persist = async (): Promise<void> => {
    const shell = bridge();
    if (!shell?.docs) return;
    try {
      await shell.docs.save(get().docs);
    } catch {
      /* 落盘失败不该把界面搅乱：下一次改动会再试一次 */
    }
  };

  const schedulePersist = (): void => {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveTimer = null;
      void persist();
    }, 400);
  };

  /** 只改某一篇。 */
  const mapDoc = (id: string, fn: (d: Doc) => Doc): void =>
    set((s) => ({ docs: s.docs.map((d) => (d.id === id ? fn(d) : d)) }));

  return {
    docs: [],
    loaded: false,
    activeId: null,
    busy: false,
    note: "",

    load: async () => {
      const shell = bridge();
      if (!shell?.docs) {
        set({ loaded: true });
        return;
      }
      try {
        const raw = await shell.docs.load();
        set({ docs: normalizeDocs(raw), loaded: true });
      } catch {
        set({ loaded: true });
      }
    },

    open: (id) => set({ activeId: id }),
    close: () => set({ activeId: null }),
    clearNote: () => set({ note: "" }),

    create: async () => {
      const doc = makeDoc(nextDocId(), Date.now());
      set((s) => ({ docs: [...s.docs, doc], activeId: doc.id }));
      await persist();
      return doc.id;
    },

    patch: (id, patch, reason) => {
      mapDoc(id, (d) => applyDocEdit(d, patch, reason, Date.now()));
      schedulePersist();
    },

    restore: (id, v) => {
      mapDoc(id, (d) => restoreDocVersion(d, v, Date.now()));
      schedulePersist();
      set({ note: "已回到该版本" });
    },

    /**
     * 操作条动作：把**整篇正文**交给模型改一遍。
     *
     * 为什么整篇给：`aiDoc_actionBar_*` 那四个动作（缩写/扩写/润色/总结概括）
     * 本来就是对整篇的（不像画布那个写作助手是对**选中文字**）。
     */
    /**
     * 调整语气（§168）：这一档要调模型 —— 语气是"表达方式"，本地改不了。
     *
     * 与 `runAction` 的差别只有指令来源（`toneInstruction`）与留痕的由来。
     */
    runTone: async (id, tone) => {
      const doc = get().docs.find((d) => d.id === id);
      if (!doc || !doc.body.trim() || get().busy) return;
      const { provider, model } = await resolveChatRoute();
      if (!provider) {
        set({ note: NO_ROUTE_MESSAGE });
        return;
      }
      set({ busy: true });
      try {
        const { text, error } = await completeOnce({
          provider,
          ...(model ? { model } : {}),
          system: "你是一个中文写作助手，只输出改完之后的正文本身。",
          messages: [{ role: "user", content: `${toneInstruction(tone)}\n\n——原文——\n${doc.body}` }],
        });
        if (error || !text.trim()) {
          set({ note: `${DOC_TONE_LABEL[tone]}失败：${error ?? "没有返回内容"}` });
          return;
        }
        get().patch(id, { body: text.trim() }, DOC_TONE_LABEL[tone]);
        set({ note: `已${DOC_TONE_LABEL[tone]}` });
      } finally {
        set({ busy: false });
      }
    },

    /**
     * 调整格式（§168）：**纯本地变换，不调模型**。
     *
     * 格式是"给小标题加 `##`"这种事 —— 交给模型既慢又可能被顺手改内容。
     */
    applyFormatTo: (id, kind, range) => {
      const doc = get().docs.find((d) => d.id === id);
      if (!doc) return;
      const next = applyFormat(doc.body, kind, range);
      if (next === doc.body) {
        // 没变化就别记一个版本（否则历史里会多一条什么都没干的记录）
        set({ note: `已经是${DOC_FORMAT_LABEL[kind]}了` });
        return;
      }
      get().patch(id, { body: next }, DOC_FORMAT_LABEL[kind]);
      set({ note: `已设为${DOC_FORMAT_LABEL[kind]}` });
    },

    pasteInto: async (id, range) => {
    const doc = get().docs.find((d) => d.id === id);
    if (!doc) return false;
    const shell = (globalThis as unknown as { shell?: ShellBridge }).shell;
    const text = (await shell?.clipboard?.read?.()) ?? "";
    if (!text) {
      // 点了没反应最糟（§163 那条"静默死亡"）—— 剪贴板是空的就直说
      set({ note: DOC_BAR_LABELS.pasteEmpty });
      return false;
    }
    get().patch(id, { body: insertAt(doc.body, range, text) }, DOC_BAR_LABELS.paste);
    set({ note: `已${DOC_BAR_LABELS.paste}` });
    return true;
  },

  attachTo: (id, range, entry) => {
    const doc = get().docs.find((d) => d.id === id);
    if (!doc) return;
    get().patch(id, { body: insertAt(doc.body, range, attachmentLink(entry.name, entry.origin)) }, DOC_BAR_LABELS.attach);
    set({ note: `已${DOC_BAR_LABELS.attach}` });
  },

  createFromText: async (text) => {
      const made = docFromMessage(text);
      if (!made) {
        set({ note: DOC_CREATE_LABELS.failed });
        return null;
      }
      const id = await get().create();
      get().patch(id, { title: made.title, body: made.body }, "从对话创建");
      // 建好之后要把那句说完 —— 用户得知道"现在可以去哪儿接着调"
      set({ note: DOC_CREATE_LABELS.created });
      return id;
    },

    runAction: async (id, action) => {
      const doc = get().docs.find((d) => d.id === id);
      if (!doc || !doc.body.trim() || get().busy) return;
      /*
       * ⚠️ 必须用**共用**的路由解析（§153）：原来这里用的是 `currentChatSettings()`
       * （只读已保存的设置，**没有回落**），于是"对话能用、润色说没通道"——
       * 同一台机器上自相矛盾，而那种错从现象上极难看出原因。
       */
      const { provider, model } = await resolveChatRoute();
      if (!provider) {
        set({ note: NO_ROUTE_MESSAGE });
        return;
      }
      set({ busy: true });
      try {
        /* 记下**发起时**的正文（回来要拿它比一比：这期间用户有没有改） */
        const sentFrom = doc.body;
        const { text, error } = await completeOnce({
          provider,
          ...(model ? { model } : {}),
          system: "你是一个中文写作助手，只输出改完之后的正文本身。",
          messages: [{ role: "user", content: `${docActionInstruction(action)}\n\n——原文——\n${doc.body}` }],
        });
        if (error || !text.trim()) {
          set({ note: `${DOC_ACTION_LABEL[action]}失败：${error ?? "没有返回内容"}` });
          return;
        }
        const rewritten = text.trim();
        /*
         * ⚠️ **改写期间正文被改过 → 不许覆盖**（2026-10-16，审计 P87）。
         *
         * 面板那边已经把它设成只读了（改不了就不会丢），这里是**兜底**：
         * 只要正文在往返期间真的变了（别处粘进来、还原版本、多窗口…），
         * 就把模型这一段**存成另一个版本**而不是覆盖他刚写的东西 —— 两边的成果都留着，
         * 并如实说明发生了什么（静默覆盖是这件事里最坏的部分）。
         */
        const now = get().docs.find((d) => d.id === id);
        if (now && now.body !== sentFrom && now.body !== rewritten) {
          get().patch(id, { body: rewritten }, `${DOC_ACTION_LABEL[action]}（改写期间的版本，未覆盖你改的）`);
          get().patch(id, { body: now.body }, "你的改动（保留了）");
          set({ note: `${DOC_ACTION_LABEL[action]}的版本已存进历史；你在改写期间的改动保留了（没被覆盖）` });
          return;
        }
        get().patch(id, { body: rewritten }, DOC_ACTION_LABEL[action]);
        set({ note: `已${DOC_ACTION_LABEL[action]}` });
      } finally {
        set({ busy: false });
      }
    },

    exportDoc: async (id) => {
      const doc = get().docs.find((d) => d.id === id);
      const shell = bridge();
      if (!doc || !shell?.workbench) return "导出通道不可用";
      try {
        // 导出成 Markdown：标题 + 正文，用户拿去就能用
        const text = `${docTitle(doc)}\n\n${doc.body}`;
        const saved = await shell.workbench.saveArtifact(`${defaultExportName(doc)}.md`, text);
        set({ note: `已导出：${saved.name}` });
        return "";
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    },

    remove: async (id) => {
      set((s) => ({ docs: s.docs.filter((d) => d.id !== id), activeId: s.activeId === id ? null : s.activeId }));
      await persist();
      set({ note: "已删除文档" });
    },
  };
});
