import type { ProviderFormatWire } from "./providerWire";

/**
 * **新供应商表单的自动推断**（M-03）。
 *
 * 主人要的字段顺序是 URL → Key → 模型；名字与格式只是"高级"里的可改项。
 * 能自动推的就别让用户填 —— 但推出来的值必须**可见、可改**（不是藏起来的猜测）。
 *
 * 放在 `shared/` 是因为 CLI（`ding providers add`）将来也要用同一套推断，
 * 两处各写一份必然漂。
 */

/**
 * 从地址推出一个默认名字：`https://api.example.com/v1` → `api.example.com`。
 *
 * 解析不了就返回空串（调用方让用户自己填，不编一个假名字）。
 */
export function nameFromUrl(url: string): string {
  const raw = String(url ?? "").trim();
  if (!raw) return "";
  try {
    const parsed = new URL(raw);
    return parsed.host || "";
  } catch {
    /* 用户可能先填了 `api.example.com` 或 `api.example.com/v1` —— 补个协议再试 */
    try {
      return new URL(`https://${raw.replace(/^\/+/, "")}`).host || "";
    } catch {
      return "";
    }
  }
}

/**
 * 从路径推断线路格式（三条规则）：
 * - 含 `/messages` → Anthropic Messages；
 * - 含 `/responses` → OpenAI Responses；
 * - 其余 → OpenAI 兼容（Chat Completions）。
 *
 * ⚠️ 反例：`/v1/chat/completions` **不能**被判成 responses（`completions` 里没有
 * `responses` 这个词，但这里仍按路径段匹配，避免 `foo-responses-bar` 这类误伤）。
 */
export function formatFromUrl(url: string): ProviderFormatWire {
  const raw = String(url ?? "").trim().toLowerCase();
  if (!raw) return "openai-compatible";
  let path = raw;
  try {
    path = new URL(raw).pathname.toLowerCase();
  } catch {
    try {
      path = new URL(`https://${raw.replace(/^\/+/, "")}`).pathname.toLowerCase();
    } catch {
      /* 保留原文（可能只写了路径片段） */
    }
  }
  if (/\/messages(?:\/|$)/.test(path)) return "anthropic";
  if (/\/responses(?:\/|$)/.test(path)) return "openai-responses";
  return "openai-compatible";
}
