import { completeOnce } from "@/ai/aiClient";
import { currentChatSettings } from "@/ai/chatStore";
import { useRuntimeStore } from "./runtimeStore";
import { appendVersion, readMeta, seedGeneration } from "./generation";
import type { GenerationMeta, GenerationNode } from "./generation";
import type { CanvasNode, NodeKind } from "./types";
import { NODE_KIND_META, makeCodeNode, makeMarkdownNode, makeMermaidNode, makeMindmapNode, nextNodeId } from "./types";

/**
 * 「选中内容 → 生成 → 结果落为节点」（PLAN 3.3 / 3.4 / 3.5，对标原版
 * `creation.selection.generate-*` / `data-canvas-generation-version` /
 * `data-canvas-generation-state` / `aiCreation_canvas_generator_failedToast`）。
 *
 * 编排只有三步：把选区读成上下文 → 让模型产出内容 → 把内容变成节点（并记一个版本）。
 * 状态机与版本都写在节点 data 的 `generation` 上，所以界面上任何一个节点都能自己显示
 * "生成中 / 失败 / 第几版"，不需要额外的全局任务表。
 */

/** 生成意图：决定输出格式与落成哪种节点。 */
export type GenerateIntent = "write" | "code" | "diagram" | "mindmap";

/* ---------- 写作助手（对标原版 `canvas_writing_shortcuts_*`） ---------- */

/**
 * 写作快捷键动作。
 *
 * 原版把它们放在文本附近的一个入口里（`canvas_writing_shortcuts_entrance_button_title`），
 * 用户选中一段文字后点一下就能改：润色、变长、变短、更通俗。
 * 这里保持同一套语义，只是入口挂在工具条的「AI 生成」里 —— 改动的是**选中节点自身**，
 * 不像生成那样落新节点，因为用户要的是"把这段改一下"。
 */
export type WritingAction = "polish" | "longer" | "shorter" | "simpler";

export const WRITING_ACTIONS: Array<{ id: WritingAction; label: string; hint: string }> = [
  { id: "polish", label: "润色", hint: "保留原意，让表达更顺、更准确" },
  { id: "longer", label: "写长一点", hint: "补充细节与例子，把内容展开" },
  { id: "shorter", label: "写短一点", hint: "删冗余，压成更紧凑的表达" },
  { id: "simpler", label: "更通俗", hint: "换成更好懂的措辞，降低阅读门槛" },
];

/** 写作动作 → 给模型的指令。 */
export function writingInstruction(action: WritingAction): string {
  switch (action) {
    case "polish":
      return "把下面这段内容润色一遍：保持原意与信息量，让表达更顺、更准确。只输出改后的正文。";
    case "longer":
      return "把下面这段内容写得更充实：补充必要的细节或例子，但不要编造事实。只输出改后的正文。";
    case "shorter":
      return "把下面这段内容压缩：删掉冗余与重复，保留关键信息。只输出改后的正文。";
    case "simpler":
      return "把下面这段内容改写得更通俗易懂：用更日常的措辞，降低阅读门槛，但不要丢信息。只输出改后的正文。";
  }
}

export type { GenerateIntent as Intent };

export const INTENT_META: Record<GenerateIntent, { label: string; output: NodeKind; hint: string }> = {
  write: { label: "写成文本", output: "markdown", hint: "扩写成 Markdown 卡片" },
  code: { label: "写成代码", output: "code", hint: "产出可运行代码" },
  diagram: { label: "画成图表", output: "mermaid", hint: "产出 Mermaid 流程图" },
  mindmap: { label: "整理成导图", output: "mindmap", hint: "产出 Markdown 大纲 → 思维导图" },
};

/** 每个节点能贡献给模型的文本。 */
function nodeText(node: CanvasNode): string {
  const data = node.data as Record<string, unknown>;
  switch (node.type) {
    case "markdown":
      return String(data.text ?? "");
    case "code":
      return `\`\`\`${String(data.lang ?? "")}\n${String(data.code ?? "")}\n\`\`\``;
    case "mermaid":
      return `\`\`\`mermaid\n${String(data.code ?? "")}\n\`\`\``;
    case "mindmap":
      return String(data.markdown ?? "");
    case "image":
      return `[图片节点] ${String(data.alt ?? "")}`;
    case "whiteboard":
      return "[白板节点：手绘草图]";
    default:
      return "";
  }
}

/**
 * 把选中的节点读成给模型看的上下文块。
 * @param nodes 选中节点
 * @param maxChars 每个节点最多取多少字（防止一个巨型节点把 prompt 顶爆）
 */
export function buildSelectionContext(nodes: CanvasNode[], maxChars = 4000): string {
  if (nodes.length === 0) return "";
  const parts = nodes.map((node, i) => {
    const title = String((node.data as { title?: string }).title ?? node.type);
    const text = nodeText(node).slice(0, maxChars);
    return `【素材 ${i + 1}｜${node.type}｜${title}】\n${text}`;
  });
  return `以下是我在画布上选中的素材：\n\n${parts.join("\n\n")}`;
}

const SYSTEM_PROMPT = [
  "你是一个在无限画布上协作的助手。用户会给你一些画布素材与一句要求。",
  "只输出最终内容本身，不要寒暄、不要解释你的思路、不要用「好的」开头。",
  "输出会被直接放进画布卡片里，所以格式要干净。",
].join("\n");

function intentInstruction(intent: GenerateIntent): string {
  switch (intent) {
    case "write":
      return "要求：用 Markdown 输出（可用标题、列表、粗体）。控制在 400 字以内，信息密度高。";
    case "code":
      return "要求：只输出一个代码块，第一行是语言标识。代码要能直接运行，带必要注释。";
    case "diagram":
      return "要求：只输出 Mermaid 代码块（首行是 flowchart / sequenceDiagram / pie / classDiagram 等类型声明），不要额外文字。";
    case "mindmap":
      return "要求：只输出 Markdown 标题大纲（用 # / ## / - 表达层级），第一行必须是一级标题，不要额外文字。";
  }
}

/**
 * 让模型产出内容（不落节点）。
 * @returns 内容与错误
 */
export async function generateContent(
  intent: GenerateIntent,
  instruction: string,
  context: string,
): Promise<{ text: string; error?: string }> {
  const { provider, model } = currentChatSettings();
  if (!provider) {
    return { text: "", error: "还没有可用的 AI 通道（在 Electron 里启动，并确保至少一个 provider 有密钥）" };
  }

  const user = [context, `要求：${instruction}`, intentInstruction(intent)]
    .filter((s) => s && s.trim())
    .join("\n\n");

  /**
   * 把这次实际发给模型的要求挂到 window 上（仅开发期）。
   *
   * 验收"标记当提示词"这类功能时，需要证明的是**请求里到底有没有那一段**。
   * preload 暴露的 `shell` 在渲染进程里是冻结的，没法在页面里包一层抓包，
   * 所以在这里留一个只读观察点。生产包里 `import.meta.env.DEV` 为假，不会挂。
   */
  if (import.meta.env.DEV && typeof window !== "undefined") {
    (window as unknown as { __lastAiPrompt?: unknown }).__lastAiPrompt = {
      provider,
      model,
      system: SYSTEM_PROMPT,
      user,
    };
  }

  const result = await completeOnce({
    provider,
    model,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: user }],
    temperature: 0.6,
  });
  return { text: cleanOutput(intent, result.text), error: result.error };
}

/** 去掉模型可能多写的围栏与前言，只留内容。 */
export function cleanOutput(intent: GenerateIntent, raw: string): string {
  let text = raw.trim();
  // 去掉整段被围栏包住的情况（保留围栏内的内容）
  const fenced = /^```[a-zA-Z]*\n([\s\S]*?)\n?```$/.exec(text);
  if (fenced) {
    if (intent === "code") return text; // 代码节点自己会剥围栏
    text = fenced[1].trim();
  }
  return text;
}

/** 从模型输出里剥出代码与语言。 */
export function parseCodeBlock(raw: string): { code: string; lang: string } {
  const match = /```([a-zA-Z0-9+#-]*)\n([\s\S]*?)```/.exec(raw);
  if (match) return { lang: (match[1] || "text").toLowerCase(), code: match[2].replace(/\s+$/, "") };
  return { lang: "text", code: raw.trim() };
}

/** 按意图把内容变成对应类型的节点。 */
function nodeFromContent(intent: GenerateIntent, content: string, at: { x: number; y: number }, existing: CanvasNode[]): CanvasNode {
  const meta = NODE_KIND_META[INTENT_META[intent].output];
  const id = nextNodeId(existing);
  switch (intent) {
    case "code": {
      const { code, lang } = parseCodeBlock(content);
      return makeCodeNode(id, at, code, lang, meta.size, "生成代码");
    }
    case "diagram":
      return makeMermaidNode(id, at, content, meta.size, "生成图表");
    case "mindmap":
      return makeMindmapNode(id, at, content, meta.size, "生成导图");
    case "write":
    default:
      return makeMarkdownNode(id, at, content, meta.size, "生成内容");
  }
}

export type GenerateResult = {
  /** 新建的节点（失败时为空）。 */
  node?: CanvasNode;
  error?: string;
};

/**
 * 完整流程：选中素材 → 生成 → 落为新节点。
 *
 * @param intent 生成意图（决定输出类型）
 * @param instruction 用户对这次生成的自然语言要求
 * @param at 新节点的世界坐标
 * @param sourceNodeIds 参考哪些节点（默认取当前选中的）
 */
export async function generateNodeFromSelection(
  intent: GenerateIntent,
  instruction: string,
  at: { x: number; y: number },
  sourceNodeIds?: string[],
): Promise<GenerateResult> {
  const store = useRuntimeStore.getState();
  const selected = sourceNodeIds
    ? store.nodes.filter((n) => sourceNodeIds.includes(n.id))
    : store.nodes.filter((n) => n.selected);

  const context = buildSelectionContext(selected);
  const { text, error } = await generateContent(intent, instruction, context);
  if (error) return { error };
  if (!text.trim()) return { error: "模型没有返回内容" };

  const latest = useRuntimeStore.getState();
  const node = nodeFromContent(intent, text, at, latest.nodes) as unknown as GenerationNode & CanvasNode;
  const { provider, model } = currentChatSettings();
  const withMeta = {
    ...node,
    data: {
      ...(node.data as unknown as Record<string, unknown>),
      generation: seedGeneration(node, model || provider || "unknown", { prompt: instruction }),
    },
  } as unknown as CanvasNode;

  useRuntimeStore.getState().commitHistory();
  useRuntimeStore.getState().addNode(withMeta);
  return { node: withMeta };
}

/**
 * 写作助手：把选中节点的内容按某个动作改一遍（对标原版 `canvas_writing_shortcuts_*`）。
 *
 * 与"生成"的区别：生成会**落一个新节点**，写作助手动的是**这个节点自己的文字** ——
 * 用户要的是"把这段改一下"，不是"再给我一份"。
 * 改完同样追加一个生成版本，所以改坏了能用版本历史/重生成回退。
 *
 * @param nodeId 目标节点
 * @param action 润色 / 写长 / 写短 / 更通俗
 * @returns 错误信息（成功时 undefined）
 */
export async function applyWritingAction(
  nodeId: string,
  action: WritingAction,
): Promise<{ error?: string }> {
  const store = useRuntimeStore.getState();
  const node = store.nodes.find((n) => n.id === nodeId);
  if (!node) return { error: "节点不存在" };

  const data = node.data as unknown as Record<string, unknown>;
  const original = typeof data.text === "string" ? data.text : typeof data.markdown === "string" ? data.markdown : "";
  if (!original.trim()) return { error: "这个节点还没有内容，先写点东西再改" };

  // 只把这段文字给模型，不带别的素材：写作动作是"就地改"，上下文越干净越准
  const { text, error } = await generateContent("write", writingInstruction(action), original);
  if (error || !text.trim()) return { error: error ?? "模型没有返回内容" };

  /**
   * 写回：先按内容键把新文字放到该放的字段（text / markdown / code …），
   * 再追加一个生成版本 —— 顺序很重要，`appendVersion` 会从**节点当前内容**里
   * `extractContent` 出这一版的内容，所以必须先把新文字写进去。
   */
  const patch = contentPatchFor(node.type as keyof typeof NODE_KIND_META, text);
  const afterContent = { ...node, data: { ...data, ...patch } } as unknown as {
    id: string;
    type: string;
    data: Record<string, unknown>;
  };
  const label = WRITING_ACTIONS.find((a) => a.id === action)?.label ?? action;
  const meta = appendVersion(afterContent, label);

  useRuntimeStore.getState().patchNodeData(nodeId, {
    ...patch,
    generation: { ...meta, status: "done", prompt: writingInstruction(action) },
  });
  return {};
}

/**
 * 重新生成某个节点的内容（PLAN 3.4：多版本重生成）。
 * 流程：置 generating → 生成 → 写内容 + 追加版本；失败则只记 failed 与原因，不动内容。
 *
 * @param nodeId 目标节点
 * @param instruction 这次重生成的要求（缺省沿用上次的 prompt）
 */
export async function regenerateNode(nodeId: string, instruction?: string): Promise<GenerateResult> {
  const store = useRuntimeStore.getState();
  const node = store.nodes.find((n) => n.id === nodeId);
  if (!node) return { error: "节点不存在" };

  const kind = node.type as keyof typeof NODE_KIND_META;
  const intent: GenerateIntent =
    kind === "code" ? "code" : kind === "mermaid" ? "diagram" : kind === "mindmap" ? "mindmap" : "write";

  const prevMeta = readMeta({ data: node.data as unknown as Record<string, unknown> });
  const prompt = instruction ?? prevMeta?.prompt ?? "改进这段内容";

  // 1) 进入生成中
  store.patchNodeData(nodeId, {
    generation: {
      contentKeys: prevMeta?.contentKeys ?? [],
      versions: prevMeta?.versions ?? [],
      activeVersion: prevMeta?.activeVersion ?? "",
      status: "generating",
      prompt,
    } satisfies GenerationMeta,
  });

  const context = buildSelectionContext([node]);
  const { text, error } = await generateContent(intent, prompt, context);

  if (error || !text.trim()) {
    const message = error ?? "模型没有返回内容";
    useRuntimeStore.getState().patchNodeData(nodeId, {
      generation: {
        ...(prevMeta ?? { contentKeys: [], versions: [], activeVersion: "" }),
        status: "failed",
        error: message,
        prompt,
      },
    });
    return { error: message };
  }

  // 2) 写回内容（按节点类型落字段）
  const patch = contentPatchFor(kind, text);
  useRuntimeStore.getState().patchNodeData(nodeId, patch);

  // 3) 追加版本并置为当前版
  const after = useRuntimeStore.getState().nodes.find((n) => n.id === nodeId);
  if (after) {
    const { provider, model } = currentChatSettings();
    const meta = appendVersion(after as unknown as GenerationNode, model || provider || "unknown");
    useRuntimeStore.getState().patchNodeData(nodeId, { generation: { ...meta, prompt } });
  }

  return { node: after };
}

/** 生成内容 → 节点 data 补丁。 */
export function contentPatchFor(kind: string, content: string): Record<string, unknown> {
  switch (kind) {
    case "code": {
      const { code, lang } = parseCodeBlock(content);
      return { code, lang, preview: true };
    }
    case "mermaid":
      return { code: content };
    case "mindmap":
      return { markdown: content };
    case "markdown":
    default:
      return { text: content };
  }
}
