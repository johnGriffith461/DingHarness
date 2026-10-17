/**
 * **给一个插件签名**（V5-4 4.4 给插件作者用的那一把）。
 *
 * 用法：
 *
 * ```bash
 * # ① 生成一把发布者钥匙（Ed25519）—— 私钥留在你手里，公钥写进清单
 * pnpm plugin-sign keygen --out ./my-publisher-key
 *
 * # ② 签名（把 publisher + signature 写进 ding-plugin.json）
 * pnpm plugin-sign sign --dir ./my-plugin --publisher my-publisher \
 *      --name "我的工作室" --key ./my-publisher-key.pem
 * ```
 *
 * ## 它签的是什么
 *
 * 两个面一起进摘要：**整棵目录的文件清单**（逐文件 sha256，排除 `node_modules`）
 * 与**清单里除 `signature` 之外的全部字段**。算法与验签那一半是同一份实现
 * （`engine/runtime/pluginSignature.ts`）—— 两处各写一遍必然漂，
 * 而"签名与验签漂了"这种事只有用户装不上插件时才被发现。
 *
 * ⚠️ 签完**再改任何文件、或改清单里任何字段**都会让验签失败。
 * 顺序是：写完插件 → 签名 → 分发；改了东西要**重新签**。
 */

import { createPrivateKey, createPublicKey, generateKeyPairSync, sign as signBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { digestOfPluginDir } from "../engine/runtime/pluginSignature";
import { indexDigest } from "../engine/runtime/pluginIndexTrust";

const argv = process.argv.slice(2);
const flag = (name: string, fallback = ""): string => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const command = argv[0];

const USAGE =
  "用法：pnpm plugin-sign keygen --out <前缀> | sign --dir <插件目录> --publisher <id> --key <私钥.pem> [--name 显示名] | " +
  "sign-index --file <index.json> --publisher <id> --key <私钥.pem> [--name 显示名]";

if (command === "keygen") {
  const out = flag("out", "ding-publisher-key");
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const pem = privateKey.export({ type: "pkcs8", format: "pem" });
  const spki = publicKey.export({ type: "spki", format: "der" });
  writeFileSync(`${out}.pem`, pem, "utf8");
  const b64 = Buffer.from(spki).toString("base64");
  writeFileSync(`${out}.pub`, `${b64}\n`, "utf8");
  console.log(`私钥（**别外传**）：${out}.pem`);
  console.log(`公钥（进清单的 publisher.key）：${out}.pub`);
  console.log(`\n${b64}\n`);
  process.exit(0);
}

if (command === "sign") {
  const dir = path.resolve(flag("dir", "."));
  const publisherId = flag("publisher");
  const keyFile = flag("key");
  const name = flag("name");
  if (!publisherId || !keyFile) {
    console.error(USAGE);
    process.exit(1);
  }

  const manifestFile = existsSync(path.join(dir, "ding-plugin.json")) ? path.join(dir, "ding-plugin.json") : null;
  if (!manifestFile) {
    console.error(`没找到 ${path.join(dir, "ding-plugin.json")} —— 这个工具的签名写进那份清单（package.json 那条渠道先手写 publisher/key）`);
    process.exit(1);
  }
  const manifest = JSON.parse(readFileSync(manifestFile, "utf8"));
  const privateKey = createPrivateKey(readFileSync(keyFile, "utf8"));
  const publicKeyB64 = Buffer.from(createPublicKey(privateKey).export({ type: "spki", format: "der" })).toString("base64");

  /* 先填 publisher（用户给的 id/name + 刚算出的公钥），再算摘要 —— 摘要覆盖整棵目录 */
  manifest.publisher = { id: publisherId, ...(name ? { name } : {}), key: publicKeyB64 };
  delete manifest.signature;
  writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

  const digest = digestOfPluginDir(dir, manifest, publicKeyB64);
  const signature = signBytes(null, Buffer.from(digest, "utf8"), privateKey).toString("base64");
  manifest.signature = signature;
  writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

  console.log(`已签名：${manifestFile}`);
  console.log(`  发布者：${publisherId}${name ? `（${name}）` : ""}`);
  console.log(`  摘要：${digest.slice(0, 16)}…（sha256，覆盖 ${dir} 下所有文件）`);
  console.log(`\n⚠️ 之后改任何文件（含这份清单）都要**重新签** —— 否则验签会失败。`);
  process.exit(0);
}

if (command === "sign-index") {
  /*
   * 给**市场索引**签名（L04）：`publisher` + `signature` 写回索引文件。
   * 摘要覆盖「除 signature 之外的全部内容 + 公钥」—— 换钥匙/改条目都会变。
   * 未签名索引也能用（首次钉摘要），但签名索引能自动接受发布者的正常更新。
   */
  const file = path.resolve(flag("file", "plugin-market/index.json"));
  const publisherId = flag("publisher");
  const keyFile = flag("key");
  const name = flag("name");
  if (!publisherId || !keyFile) {
    console.error(USAGE);
    process.exit(1);
  }
  if (!existsSync(file)) {
    console.error(`没找到索引文件：${file}`);
    process.exit(1);
  }
  const index = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  const privateKey = createPrivateKey(readFileSync(keyFile, "utf8"));
  const publicKeyB64 = Buffer.from(createPublicKey(privateKey).export({ type: "spki", format: "der" })).toString("base64");

  index.publisher = { id: publisherId, ...(name ? { name } : {}), key: publicKeyB64 };
  delete index.signature;
  writeFileSync(file, `${JSON.stringify(index, null, 2)}\n`, "utf8");

  const digest = indexDigest(index, publicKeyB64);
  const signature = signBytes(null, Buffer.from(digest, "utf8"), privateKey).toString("base64");
  index.signature = signature;
  writeFileSync(file, `${JSON.stringify(index, null, 2)}\n`, "utf8");

  console.log(`已签名：${file}`);
  console.log(`  发布者：${publisherId}${name ? `（${name}）` : ""}`);
  console.log(`  摘要：${digest.slice(0, 16)}…（sha256，覆盖索引除 signature 外的全部内容）`);
  console.log(`\n⚠️ 之后改索引里任何条目都要**重新签**。`);
  process.exit(0);
}

console.error(USAGE);
process.exit(1);
