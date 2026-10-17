import { z } from "zod";

import type { AgentToolSpec } from "./agentTools";

/**
 * **知识库检索工具**（G15，2026-10-18）。
 *
 * 在这之前 RAG 只在 CLI 里（`ding knowledge ask`）—— agent 自己调不到。
 * 这个工具让模型能主动搜本地知识库，返回**带编号的片段**，便于它按
 * `[1]` `[2]` 引用（与 `ding knowledge ask` 同一套引用口径）。
 */

export const KNOWLEDGE_SEARCH_TOOL = "knowledge_search";

export const KNOWLEDGE_SEARCH_INPUT = z.object({
  query: z.string().trim().min(1).describe("要搜的词或问题"),
  limit: z.number().int().min(1).max(20).optional().describe("最多几条，默认 6"),
});

export const KNOWLEDGE_SEARCH_DESC = [
  "在**本机知识库**里检索与问题相关的片段。",
  "用户提到「我之前上传的资料 / 那个文档」时用它；不要在没检索的情况下凭印象回答。",
  "返回的每段都带编号与来源（文件路径），引用时用 `[n]` 标注。",
  "资料里没有就说「资料里没有提到」——不要编。",
].join("");

export const KNOWLEDGE_TOOL_SPECS: readonly AgentToolSpec[] = [
  { name: KNOWLEDGE_SEARCH_TOOL, description: KNOWLEDGE_SEARCH_DESC, schema: KNOWLEDGE_SEARCH_INPUT },
];

/** 是不是知识库工具。 */
export function isKnowledgeTool(name: string): boolean {
  return name === KNOWLEDGE_SEARCH_TOOL;
}

/** 把检索结果拼成给模型看的一段（编号 + 来源 + 正文）。 */
export function describeHits(
  hits: ReadonlyArray<{ citation: string; text: string }>,
): { line: string; text: string } {
  if (!hits.length) {
    return { line: "知识库里没有匹配的片段", text: "（没有检索到相关资料 —— 直接说资料里没有提到，不要猜）" };
  }
  const text = hits.map((hit, index) => `[${index + 1}] ${hit.citation}\n${hit.text}`).join("\n\n");
  return { line: `检索到 ${hits.length} 段相关资料`, text };
}
