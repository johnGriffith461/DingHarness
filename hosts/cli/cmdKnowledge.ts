/**
 * `ding knowledge` —— 本地知识库（V6-3e）。
 *
 * ```
 * ding knowledge add <文件|目录> [--domain private|team] [--owner <id>]
 * ding knowledge search <词> [--limit n] [--json]
 * ding knowledge ask <问题> [--limit n]          # 真模型 + 引用（会花钱）
 * ding knowledge list [--json]
 * ding knowledge remove <id|路径>
 * ```
 *
 * 索引是本地的（`<数据目录>/knowledge.db`），删库不删原文件。
 * `ask` 只把**检索到的片段**交给模型，并要求它标注 `[n]`；回答末尾列出来源，
 * 用户能回原文核对。
 */
import { ingestPath } from "../../engine/rag/ingest";
import { openKnowledgeStore } from "../../engine/rag/store";
import { buildEngine } from "./assembly";
import { flag, parseIntFlagValue, type Parsed } from "./args";

/** 提取正文里出现的 `[n]`（用来判断模型到底引没引用）。 */
export function citedIndexes(text: string): number[] {
  const out = new Set<number>();
  for (const match of text.matchAll(/\[(\d+)\]/g)) out.add(Number(match[1]));
  return [...out].sort((a, b) => a - b);
}

/** 拼给模型的资料块（带编号，便于引用）。 */
export function buildKnowledgePrompt(question: string, hits: readonly { citation: string; text: string }[]): { system: string; user: string } {
  const sources = hits.map((hit, index) => `[${index + 1}] ${hit.citation}\n${hit.text}`).join("\n\n");
  return {
    system:
      "你是一个只依据给定资料回答问题的助手。\n" +
      "规则：\n" +
      "1. 只使用资料里的内容；资料里没有就说「资料里没有提到」，不要猜；\n" +
      "2. 每条结论后用 [n] 标注来源编号；\n" +
      "3. 不要编造来源，也不要引用没有给出的编号。",
    user: `资料：\n${sources || "（没有检索到相关资料）"}\n\n问题：${question}`,
  };
}

export async function cmdKnowledge(p: Parsed, dataDir: string): Promise<number> {
  const sub = p.args[0] ?? "list";
  const store = openKnowledgeStore(dataDir);
  try {
    if (sub === "add") {
      const target = p.args.slice(1).join(" ");
      if (!target) {
        process.stderr.write("用法：ding knowledge add <文件|目录> [--domain private|team] [--owner <id>]\n");
        return 2;
      }
      const domain = flag(p, "domain");
      if (domain && domain !== "private" && domain !== "team") {
        process.stderr.write(`--domain 只能是 private 或 team（给了「${domain}」）\n`);
        return 2;
      }
      const owner = flag(p, "owner");
      try {
        const result = await ingestPath(store, target, {
          ...(domain ? { domain: domain as "private" | "team" } : {}),
          ...(owner ? { owner } : {}),
        });
        if (p.flags.has("json")) {
          process.stdout.write(JSON.stringify(result, null, 2) + "\n");
        } else {
          for (const item of result.added) {
            process.stdout.write(`✓ ${item.path}（${item.chunks} 段${item.replaced ? "，替换了旧版本" : ""}）\n`);
          }
          for (const item of result.skipped) process.stderr.write(`⚠️ 跳过 ${item.path}：${item.reason}\n`);
          process.stdout.write(`\n共入库 ${result.added.length} 份，跳过 ${result.skipped.length} 份。库：${store.file}\n`);
        }
        return result.added.length ? 0 : 1;
      } catch (error) {
        process.stderr.write(`${String((error as Error)?.message ?? error)}\n`);
        return 1;
      }
    }

    if (sub === "search") {
      const query = p.args.slice(1).join(" ");
      if (!query) {
        process.stderr.write("用法：ding knowledge search <词> [--limit n] [--json]\n");
        return 2;
      }
      const limit = parseIntFlagValue(flag(p, "limit"), "limit", { min: 1, max: 50, fallback: 8 });
      if (!limit.ok) {
        process.stderr.write(`${limit.message}\n`);
        return 2;
      }
      const hits = store.search(query, { viewer: "local", limit: limit.value });
      if (p.flags.has("json")) {
        process.stdout.write(JSON.stringify(hits, null, 2) + "\n");
        return 0;
      }
      if (!hits.length) {
        process.stdout.write(`没有命中「${query}」（库：${store.file}）\n`);
        return 0;
      }
      hits.forEach((hit, index) => {
        process.stdout.write(`[${index + 1}] ${hit.citation}　（相关度 ${hit.score.toFixed(2)}）\n`);
        process.stdout.write(`    ${hit.text.replace(/\s+/g, " ").slice(0, 220)}\n`);
      });
      return 0;
    }

    if (sub === "ask") {
      const question = p.args.slice(1).join(" ");
      if (!question) {
        process.stderr.write("用法：ding knowledge ask <问题> [--limit n]\n");
        return 2;
      }
      const limit = parseIntFlagValue(flag(p, "limit"), "limit", { min: 1, max: 20, fallback: 6 });
      if (!limit.ok) {
        process.stderr.write(`${limit.message}\n`);
        return 2;
      }
      const hits = store.search(question, { viewer: "local", limit: limit.value });
      if (!hits.length) {
        process.stdout.write("知识库里没有相关资料（先 ding knowledge add <文件|目录>）。\n");
        return 1;
      }
      const { system, user } = buildKnowledgePrompt(question, hits);
      const built = await buildEngine([process.cwd()], dataDir);
      let answer = "";
      try {
        const outcome = await built.engine.run({
          provider: flag(p, "provider") ?? "deepseek",
          ...(flag(p, "model") ? { model: flag(p, "model")! } : {}),
          system,
          messages: [{ role: "user", content: user }],
          mode: "按需确认",
          useTools: false,
          maxSteps: 1,
          onEvent: (event) => {
            if (event.type === "text") {
              answer += event.text;
              process.stdout.write(event.text);
            } else if (event.type === "error") process.stderr.write(`\n${event.message}\n`);
          },
        });
        if (!outcome.ok) return 1;
        const cited = citedIndexes(answer);
        process.stdout.write("\n\n来源：\n");
        hits.forEach((hit, index) => {
          process.stdout.write(`  [${index + 1}] ${hit.citation}\n`);
        });
        if (!cited.length) process.stdout.write("\n⚠️ 回答里没有出现 [n] 引用标记 —— 这份回答没有可核对的出处，谨慎采信。\n");
        return 0;
      } finally {
        built.close();
      }
    }

    if (sub === "list") {
      const docs = store.list("local");
      if (p.flags.has("json")) {
        process.stdout.write(JSON.stringify(docs, null, 2) + "\n");
        return 0;
      }
      if (!docs.length) {
        process.stdout.write(`知识库是空的（库：${store.file}）。加一份：ding knowledge add <文件|目录>\n`);
        return 0;
      }
      for (const doc of docs) {
        process.stdout.write(
          `${doc.title}　[${doc.domain}${doc.domain === "private" ? `/${doc.owner}` : ""}]　${doc.chunks} 段　${(doc.bytes / 1024).toFixed(1)} KB\n    ${doc.path}\n`,
        );
      }
      return 0;
    }

    if (sub === "remove") {
      const target = p.args[1];
      if (!target) {
        process.stderr.write("用法：ding knowledge remove <文档 id|路径>\n");
        return 2;
      }
      const got = store.removeDocument(target);
      if (!got.removed) {
        process.stderr.write(`没找到：${target}\n`);
        return 1;
      }
      process.stdout.write(`✓ 删掉了 ${got.removed} 段（**原文件没动**；要重建就重新 add）\n`);
      return 0;
    }

    process.stderr.write("用法：ding knowledge add|search|ask|list|remove …\n");
    return 2;
  } finally {
    store.close();
  }
}
