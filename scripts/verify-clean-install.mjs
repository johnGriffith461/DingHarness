#!/usr/bin/env node
/**
 * **干净机器安装验证**（U12）：空缓存 + 空前缀，从公开 registry 装一遍。
 *
 * 与 `verify-cli-npm.mjs` 的分工：
 *   · 那个验的是**本仓构建出来的** `dist-cli`（产物与源码一致、能跑）；
 *   · 这个验的是**发布出去的那个包**：`npm i -g ding-harness@<version>` 在
 *     空缓存、空 prefix 下能不能装上、装上的能不能跑。
 *
 * ⚠️ 这条**要联网**（registry），所以不串进 `pnpm verify`。手动跑：
 *   node scripts/verify-clean-install.mjs
 *   NPM_REGISTRY=https://registry.npmjs.org node scripts/verify-clean-install.mjs
 *
 * 判据：
 *   ① 安装退出码 0；
 *   ② `ding --version` 等于 `shared/version.json`；
 *   ③ `ding eval` 通过率 100%（63/63）—— 证明随包带的内核与数据都在。
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const version = JSON.parse(readFileSync(new URL("../shared/version.json", import.meta.url), "utf8")).version;
const registry = process.env.NPM_REGISTRY?.trim() || "https://registry.npmjs.org";
const root = mkdtempSync(path.join(os.tmpdir(), "dh-clean-install-"));
const prefix = path.join(root, "prefix");
const cache = path.join(root, "cache");
const problems = [];
let child;

const run = (cmd, args, opts = {}) => {
  /*
   * Windows 上 `npm` / `ding` 是 `.cmd`：必须过 `cmd.exe /c`。
   * 但**不能**用 `shell:true` + 参数数组（Node 会警告"只拼接不转义"）——
   * 这里自己拼一条命令，含空格的参数加引号。
   */
  const isWin = process.platform === "win32";
  const quote = (value) => (/[\s"&|<>^]/.test(value) ? `"${value.replace(/"/g, '\\"')}"` : value);
  const [file, argv] = isWin
    ? ["cmd.exe", ["/d", "/s", "/c", [cmd, ...args].map(quote).join(" ")]]
    : [cmd, args];
  const got = spawnSync(file, argv, { encoding: "utf8", ...opts });
  return { code: got.status ?? -1, out: `${got.stdout ?? ""}${got.stderr ?? ""}` };
};

try {
  console.log(`装 ding-harness@${version}（registry=${registry}，空缓存 ${cache}）…`);
  const install = run("npm", [
    "install",
    "-g",
    `ding-harness@${version}`,
    "--prefix",
    prefix,
    "--cache",
    cache,
    `--registry=${registry}`,
    "--fund=false",
    "--audit=false",
    "--no-update-notifier",
  ]);
  if (install.code !== 0) {
    problems.push(`npm install 失败（退出码 ${install.code}）：${install.out.trim().split("\n").slice(-5).join(" / ")}`);
  }

  const bin = path.join(prefix, process.platform === "win32" ? "ding.cmd" : "bin/ding");
  const ver = run(bin, ["--version"]);
  if (ver.code !== 0) problems.push(`ding --version 失败：${ver.out.trim().slice(-200)}`);
  else if (ver.out.trim() !== version) problems.push(`版本不对：装出来是 ${ver.out.trim()}，期望 ${version}`);

  const evalRun = run(bin, ["eval"], { timeout: 180_000 });
  const evalLine = /共 63 条，通过 (\d+)，失败 (\d+)/.exec(evalRun.out);
  if (!evalLine) problems.push(`eval 没打出总数：${evalRun.out.trim().slice(-300)}`);
  else if (evalLine[1] !== "63" || evalLine[2] !== "0") {
    problems.push(`eval 不是 63/63：通过 ${evalLine[1]}，失败 ${evalLine[2]}`);
  }

  console.log(
    JSON.stringify(
      {
        version: ver.out.trim(),
        installExit: install.code,
        eval: evalLine ? `${evalLine[1]}/63` : "没解析到",
        registry,
      },
      null,
      2,
    ),
  );
} finally {
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    /* Windows 上 npm 可能还占着：尽力而为 */
  }
}

if (problems.length) {
  console.error("✗ " + problems.join("；"));
  process.exitCode = 1;
} else {
  console.log("✓ 干净安装：空缓存空前缀装得上、版本对、eval 63/63");
}
