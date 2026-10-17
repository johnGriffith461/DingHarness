/**
 * **市场索引的信任**（L04 插件市场 v2）。
 *
 * ## 之前缺的那一块
 *
 * `pluginIndex.ts` 只做结构校验（字段在不在、版本能不能解析）。索引本身
 * **没有任何完整性凭据**：一份远程索引被换掉之后，用户看到的还是"同一个 URL"，
 * 而里面的安装来源已经全指向别人 —— 插件签名拦不住这件事，因为攻击者
 * 可以指向**没有签名**的包（v1 插件允许无签名安装）。
 *
 * ## 两条独立的路
 *
 * | 索引形态 | 怎么判 |
 * |---|---|
 * | 带 `publisher` + `signature` | 验签；**换钥匙一律拒**（TOFU，与插件发布者同一套直觉） |
 * | 不带签名 | 首次见到就**钉住摘要**；之后内容一变就拒，除非用户显式 `--accept-index-change` |
 *
 * 为什么未签名索引也要钉：本地文件/内网镜像没有发行者，但"同一个来源的内容
 * 悄悄变了"仍然是用户该知道的事。钉住不让它静默通过，同时给一条明确的放行路
 * （用户自己换索引是正常操作）。
 *
 * ## 钉的是什么
 *
 * 索引内容的规范化摘要 —— **不含 `signature` 字段本身**（签名不能覆盖自己）。
 * `publisher.key` 进摘要：换钥匙等于换内容，签名也要跟着变。
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import type { PluginPublisher } from "./plugins";
import { canonicalJson, verifyPublisherDigest } from "./pluginSignature";

/** 钉文件的格式版本（改结构必须升版本）。 */
export const INDEX_PIN_FORMAT = 1;

/** 一条索引钉。 */
export type IndexPin = {
  source: string;
  digest: string;
  /** 签名索引的发布者（未签名索引没有）。 */
  publisherId?: string;
  publisherKey?: string;
  /** 第一次钉住（epoch ms）。 */
  acceptedAt: number;
  /** 最后一次见到（epoch ms）。 */
  lastSeenAt: number;
};

/** 钉文件的形状。 */
export type IndexPins = { format: number; indexes: IndexPin[] };

/** 索引钉文件放在哪儿（与插件台账同一层：都是"我们的账"）。 */
export function indexPinsFileOf(pluginRoot: string): string {
  return path.join(path.dirname(pluginRoot), "plugin-index-pins.json");
}

/** 读钉文件；读不出来给空表（表坏了不该让市场全用不了，但绝不假装"钉过"）。 */
export function readIndexPins(file: string): IndexPins {
  if (!existsSync(file)) return { format: INDEX_PIN_FORMAT, indexes: [] };
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as { format?: unknown; indexes?: unknown };
    if (parsed.format !== INDEX_PIN_FORMAT) return { format: INDEX_PIN_FORMAT, indexes: [] };
    const list = Array.isArray(parsed.indexes) ? parsed.indexes : [];
    const indexes: IndexPin[] = [];
    for (const raw of list) {
      const item = raw as Partial<IndexPin>;
      if (typeof item?.source !== "string" || typeof item?.digest !== "string") continue;
      indexes.push({
        source: item.source,
        digest: item.digest,
        ...(typeof item.publisherId === "string" ? { publisherId: item.publisherId } : {}),
        ...(typeof item.publisherKey === "string" ? { publisherKey: item.publisherKey } : {}),
        acceptedAt: typeof item.acceptedAt === "number" ? item.acceptedAt : 0,
        lastSeenAt: typeof item.lastSeenAt === "number" ? item.lastSeenAt : 0,
      });
    }
    return { format: INDEX_PIN_FORMAT, indexes };
  } catch {
    return { format: INDEX_PIN_FORMAT, indexes: [] };
  }
}

/** 写钉文件（一次到位；目录不在就建）。 */
export function writeIndexPins(file: string, pins: IndexPins): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify({ format: INDEX_PIN_FORMAT, indexes: pins.indexes }, null, 2)}\n`, "utf8");
}

/**
 * 索引内容的签名摘要。
 *
 * @param raw 已 JSON.parse 的索引（不可信）
 * @param publisherKey 发布者公钥（未签名索引传 `""`）
 * @returns 摘要（64 位十六进制）
 */
export function indexDigest(raw: unknown, publisherKey: string): string {
  const body = { ...((raw ?? {}) as Record<string, unknown>) };
  delete body.signature;
  const canonicalBody = JSON.stringify({
    v: 1,
    index: JSON.parse(canonicalJson(body)),
    publisher: publisherKey,
  });
  return createHash("sha256").update(`ding-plugin-index/1\u0000${canonicalBody}`).digest("hex");
}

/** 索引顶层的发布者/签名字段（两边必须成对）。 */
function publisherFieldsOf(raw: unknown): { publisher?: PluginPublisher; signature?: string; problem?: string } {
  if (!raw || typeof raw !== "object") return {};
  const o = raw as Record<string, unknown>;
  const rawPublisher = typeof o.publisher === "object" && o.publisher !== null ? (o.publisher as Record<string, unknown>) : undefined;
  const signature = typeof o.signature === "string" ? o.signature.trim() : "";
  if (!rawPublisher) {
    if (signature) return { problem: "索引有 signature 但没有 publisher —— 没法知道该用哪把钥匙验" };
    if (o.publisher !== undefined) return { problem: "索引的 publisher 必须是对象：{id, name?, key}" };
    return {};
  }
  if (!signature) return { problem: "索引有 publisher 但没有 signature —— 声明了发行者却没签，拒绝当作已签名索引" };
  const id = typeof rawPublisher.id === "string" ? rawPublisher.id.trim() : "";
  const key = typeof rawPublisher.key === "string" ? rawPublisher.key.trim() : "";
  if (!id || !key) return { problem: "索引的 publisher 必须有 id 与 key（base64 的 ed25519 公钥）" };
  return {
    publisher: {
      id,
      key,
      ...(typeof rawPublisher.name === "string" ? { name: rawPublisher.name } : {}),
    },
    signature,
  };
}

/** 一次索引信任判定的结论。 */
export type IndexTrustVerdict =
  | {
      ok: true;
      digest: string;
      /** `new` 首次钉住 / `unchanged` 与钉住的一致 / `signed` 签名有效 / `accepted-change` 用户显式放行。 */
      trust: "new" | "unchanged" | "signed" | "accepted-change";
      pin: IndexPin;
      note: string;
    }
  | {
      ok: false;
      reason: "bad-shape" | "bad-key" | "bad-signature" | "changed" | "publisher-changed";
      message: string;
      digest?: string;
    };

/**
 * 判一份索引能不能用，并在通过时给出更新后的钉表。
 *
 * @param input.source 索引来源（本地绝对路径或 URL —— 钉按来源区分）
 * @param input.raw 已 JSON.parse 的索引
 * @param input.pins 现有钉表
 * @param input.acceptChange 用户是否显式接受"未签名索引内容变了"
 * @param input.now 当前时间（测试注入）
 */
export function checkIndexTrust(input: {
  source: string;
  raw: unknown;
  pins: IndexPins;
  acceptChange?: boolean;
  now?: number;
}): { verdict: IndexTrustVerdict; pins: IndexPins } {
  const now = input.now ?? Date.now();
  const shape = publisherFieldsOf(input.raw);
  if (shape.problem) {
    return {
      verdict: { ok: false, reason: "bad-shape", message: shape.problem },
      pins: input.pins,
    };
  }

  const digest = indexDigest(input.raw, shape.publisher?.key ?? "");
  if (shape.publisher && shape.signature) {
    const signed = verifyPublisherDigest({ publisher: shape.publisher, signature: shape.signature, digest });
    if (!signed.ok) {
      return {
        verdict: {
          ok: false,
          reason: signed.reason === "bad-key" ? "bad-key" : "bad-signature",
          message: signed.message,
          digest,
        },
        pins: input.pins,
      };
    }
  }

  const previous = input.pins.indexes.find((pin) => pin.source === input.source);
  if (previous && shape.publisher && previous.publisherKey && previous.publisherKey !== shape.publisher.key) {
    return {
      verdict: {
        ok: false,
        reason: "publisher-changed",
        message:
          `索引发布者「${shape.publisher.id}」换了一把公钥（钉住的是 ${previous.publisherKey.slice(0, 12)}…，` +
          `现在这份是 ${shape.publisher.key.slice(0, 12)}…）。换钥匙要么是发布者在轮换、要么是有人冒充 —— ` +
          `两种都不该由"打开市场"默认接受。已用旧钥匙钉过，拒绝。`,
        digest,
      },
      pins: input.pins,
    };
  }

  if (!previous && !shape.publisher) {
    const pin: IndexPin = { source: input.source, digest, acceptedAt: now, lastSeenAt: now };
    return {
      verdict: { ok: true, digest, trust: "new", pin, note: "第一次见到这份索引，已钉住它的摘要（之后内容一变就会拒）" },
      pins: { ...input.pins, indexes: [...input.pins.indexes, pin] },
    };
  }
  if (!previous && shape.publisher) {
    const pin: IndexPin = {
      source: input.source,
      digest,
      publisherId: shape.publisher.id,
      publisherKey: shape.publisher.key,
      acceptedAt: now,
      lastSeenAt: now,
    };
    return {
      verdict: {
        ok: true,
        digest,
        trust: "signed",
        pin,
        note: `索引已签名（发布者 ${shape.publisher.id}），首次见到，已钉住这把公钥`,
      },
      pins: { ...input.pins, indexes: [...input.pins.indexes, pin] },
    };
  }

  const pin: IndexPin = {
    ...previous!,
    digest,
    lastSeenAt: now,
    ...(shape.publisher ? { publisherId: shape.publisher.id, publisherKey: shape.publisher.key } : {}),
  };
  const next = { ...input.pins, indexes: input.pins.indexes.map((x) => (x.source === input.source ? pin : x)) };

  if (shape.publisher) {
    return {
      verdict: {
        ok: true,
        digest,
        trust: "signed",
        pin,
        note: `索引已签名（发布者 ${shape.publisher.id}），签名与发布者都对得上`,
      },
      pins: next,
    };
  }
  if (previous!.digest === digest) {
    return { verdict: { ok: true, digest, trust: "unchanged", pin, note: "索引内容与上次一致" }, pins: next };
  }
  if (input.acceptChange) {
    return {
      verdict: {
        ok: true,
        digest,
        trust: "accepted-change",
        pin,
        note: "索引内容变了（未签名），你显式接受了这次变化，摘要已更新",
      },
      pins: next,
    };
  }
  return {
    verdict: {
      ok: false,
      reason: "changed",
      digest,
      message:
        "这份索引没有签名，而且内容与上次钉住的不一致 —— 可能是你自己换了索引，也可能是它被换掉了。" +
        "确认来源可信后，加 --accept-index-change 重跑。",
    },
    pins: input.pins,
  };
}
