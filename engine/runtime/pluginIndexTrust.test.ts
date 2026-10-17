import { generateKeyPairSync, sign as signBytes } from "node:crypto";
import { rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  INDEX_PIN_FORMAT,
  checkIndexTrust,
  indexDigest,
  indexPinsFileOf,
  readIndexPins,
  writeIndexPins,
  type IndexPins,
} from "./pluginIndexTrust";

/**
 * **市场索引信任**（L04）的回归。
 *
 * 判据按用户真正会遇到的几种情形：
 * ① 第一次见到未签名索引 → 钉住（能用）；
 * ② 同一份内容再来 → unchanged；
 * ③ 内容悄悄变了 → 拒（除非显式接受）；
 * ④ 签名索引 → 验签通过才用；
 * ⑤ 同一个发布者换钥匙 → 拒（TOFU）。
 */

const keyPair = () => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    publicKey: Buffer.from(publicKey.export({ type: "spki", format: "der" })).toString("base64"),
    privateKey,
  };
};

const indexOf = (plugins: unknown[], extra: Record<string, unknown> = {}) => ({
  format: 1,
  updatedAt: "2026-10-18",
  plugins,
  ...extra,
});

const emptyPins = (): IndexPins => ({ format: INDEX_PIN_FORMAT, indexes: [] });

/** 给一份索引签名（与 scripts/plugin-sign.ts 同一条算法）。 */
function signIndex(
  raw: Record<string, unknown>,
  publisherId: string,
  privateKey: ReturnType<typeof keyPair>["privateKey"],
  publicKey: string,
): Record<string, unknown> {
  raw.publisher = { id: publisherId, key: publicKey };
  delete raw.signature;
  const digest = indexDigest(raw, publicKey);
  raw.signature = signBytes(null, Buffer.from(digest, "utf8"), privateKey).toString("base64");
  return raw;
}

const pinFiles: string[] = [];
afterEach(() => {
  for (const file of pinFiles.splice(0)) rmSync(file, { force: true });
});

describe("未签名索引：首次钉住，内容变了就拒", () => {
  it("第一次见到 → ok/new，钉表里出现这条", () => {
    const raw = indexOf([{ id: "a", version: "1.0.0", enginesDing: ">=0.5.0", npm: "a" }]);
    const { verdict, pins } = checkIndexTrust({ source: "/market/index.json", raw, pins: emptyPins(), now: 100 });
    expect(verdict.ok).toBe(true);
    if (verdict.ok) expect(verdict.trust).toBe("new");
    expect(pins.indexes).toHaveLength(1);
    expect(pins.indexes[0]?.digest).toBe(indexDigest(raw, ""));
    expect(pins.indexes[0]?.acceptedAt).toBe(100);
  });

  it("同样内容再来 → unchanged（摘要一致）", () => {
    const raw = indexOf([{ id: "a", version: "1.0.0", enginesDing: ">=0.5.0", npm: "a" }]);
    const first = checkIndexTrust({ source: "/market/index.json", raw, pins: emptyPins(), now: 100 });
    const second = checkIndexTrust({ source: "/market/index.json", raw, pins: first.pins, now: 200 });
    expect(second.verdict.ok).toBe(true);
    if (second.verdict.ok) expect(second.verdict.trust).toBe("unchanged");
    expect(second.pins.indexes[0]?.lastSeenAt).toBe(200);
  });

  it("内容变了但没签名、没显式接受 → 拒，钉表不动", () => {
    const first = checkIndexTrust({
      source: "/market/index.json",
      raw: indexOf([{ id: "a", version: "1.0.0", enginesDing: ">=0.5.0", npm: "a" }]),
      pins: emptyPins(),
    });
    const changed = indexOf([{ id: "a", version: "2.0.0", enginesDing: ">=0.5.0", npm: "a" }]);
    const verdict = checkIndexTrust({ source: "/market/index.json", raw: changed, pins: first.pins });
    expect(verdict.verdict.ok).toBe(false);
    if (!verdict.verdict.ok) expect(verdict.verdict.reason).toBe("changed");
    expect(verdict.pins.indexes[0]?.digest).toBe(first.pins.indexes[0]?.digest);
  });

  it("显式接受变化 → accepted-change，钉更新", () => {
    const first = checkIndexTrust({
      source: "/market/index.json",
      raw: indexOf([{ id: "a", version: "1.0.0", enginesDing: ">=0.5.0", npm: "a" }]),
      pins: emptyPins(),
    });
    const changed = indexOf([{ id: "a", version: "2.0.0", enginesDing: ">=0.5.0", npm: "a" }]);
    const verdict = checkIndexTrust({ source: "/market/index.json", raw: changed, pins: first.pins, acceptChange: true });
    expect(verdict.verdict.ok).toBe(true);
    if (verdict.verdict.ok) expect(verdict.verdict.trust).toBe("accepted-change");
    expect(verdict.pins.indexes[0]?.digest).toBe(indexDigest(changed, ""));
  });

  it("不同来源各钉各的（同一个内容放在两个路径下是两份）", () => {
    const raw = indexOf([]);
    const first = checkIndexTrust({ source: "/a/index.json", raw, pins: emptyPins() });
    const second = checkIndexTrust({ source: "/b/index.json", raw, pins: first.pins });
    expect(second.verdict.ok).toBe(true);
    if (second.verdict.ok) expect(second.verdict.trust).toBe("new");
    expect(second.pins.indexes).toHaveLength(2);
  });
});

describe("签名索引：验签 + 换钥匙拒绝", () => {
  it("签名有效 → signed，并钉住发布者", () => {
    const keys = keyPair();
    const raw = signIndex(
      indexOf([{ id: "a", version: "1.0.0", enginesDing: ">=0.5.0", npm: "a" }]),
      "ding-samples",
      keys.privateKey,
      keys.publicKey,
    );
    const { verdict, pins } = checkIndexTrust({ source: "/market/index.json", raw, pins: emptyPins(), now: 100 });
    expect(verdict.ok).toBe(true);
    if (verdict.ok) expect(verdict.trust).toBe("signed");
    expect(pins.indexes[0]?.publisherId).toBe("ding-samples");
    expect(pins.indexes[0]?.publisherKey).toBe(keys.publicKey);
  });

  it("签名有效时，内容更新自动接受（发布者签过的就是它想要的）", () => {
    const keys = keyPair();
    const first = signIndex(indexOf([]), "ding-samples", keys.privateKey, keys.publicKey);
    const one = checkIndexTrust({ source: "/market/index.json", raw: first, pins: emptyPins() });
    const updated = signIndex(
      indexOf([{ id: "b", version: "1.0.0", enginesDing: ">=0.5.0", npm: "b" }]),
      "ding-samples",
      keys.privateKey,
      keys.publicKey,
    );
    const two = checkIndexTrust({ source: "/market/index.json", raw: updated, pins: one.pins });
    expect(two.verdict.ok).toBe(true);
    if (two.verdict.ok) expect(two.verdict.trust).toBe("signed");
  });

  it("签名被改过 → bad-signature 拒绝", () => {
    const keys = keyPair();
    const raw = signIndex(indexOf([]), "ding-samples", keys.privateKey, keys.publicKey);
    raw.signature = Buffer.from("not a signature").toString("base64");
    const { verdict } = checkIndexTrust({ source: "/market/index.json", raw, pins: emptyPins() });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toBe("bad-signature");
  });

  it("同一个发布者换了一把钥匙 → publisher-changed 拒绝", () => {
    const oldKeys = keyPair();
    const first = signIndex(indexOf([]), "ding-samples", oldKeys.privateKey, oldKeys.publicKey);
    const one = checkIndexTrust({ source: "/market/index.json", raw: first, pins: emptyPins() });
    const newKeys = keyPair();
    const fresh = signIndex(indexOf([]), "ding-samples", newKeys.privateKey, newKeys.publicKey);
    const two = checkIndexTrust({ source: "/market/index.json", raw: fresh, pins: one.pins });
    expect(two.verdict.ok).toBe(false);
    if (!two.verdict.ok) expect(two.verdict.reason).toBe("publisher-changed");
  });

  it("只有 publisher 没有 signature → bad-shape（不许当作已签名）", () => {
    const keys = keyPair();
    const raw = indexOf([], { publisher: { id: "ding-samples", key: keys.publicKey } });
    const { verdict } = checkIndexTrust({ source: "/market/index.json", raw, pins: emptyPins() });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toBe("bad-shape");
  });
});

describe("钉文件读写", () => {
  it("写进去能读回来；坏文件当空表", () => {
    const file = path.join(os.tmpdir(), `dh-index-pins-${process.pid}-${Date.now()}.json`);
    pinFiles.push(file);
    const pins: IndexPins = {
      format: INDEX_PIN_FORMAT,
      indexes: [{ source: "/market/index.json", digest: "abc", acceptedAt: 1, lastSeenAt: 2 }],
    };
    writeIndexPins(file, pins);
    expect(readIndexPins(file).indexes).toEqual(pins.indexes);

    writeFileSync(file, "{ 坏 json", "utf8");
    expect(readIndexPins(file).indexes).toEqual([]);
  });

  it("钉文件位置在插件目录旁边", () => {
    expect(indexPinsFileOf("C:/data/plugins").replace(/\\/g, "/")).toBe("C:/data/plugin-index-pins.json");
  });
});
