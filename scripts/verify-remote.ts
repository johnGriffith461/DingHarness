/**
 * 一次性（也是常驻的验收）：**远端 agent 的客户端**（Phase 17 的另一半）端到端。
 *
 * 它真起三样东西：
 *   ① 假 provider（离线，不花钱）：`startFakeProvider`
 *   ② `ding serve`（HTTP + SSE，只绑回环）
 *   ③ `ding connect`（客户端）→ 断言它把远端那轮**跑成并流式打出来了**
 *
 * ## 为什么值得单独一条
 *
 * `ding serve` 早就有了，但客户端一直是缺口（CHANGELOG 如实记着）。
 * 这条验收挡的是"客户端真的会说话"：拿到 info、拿到 token 才放行、SSE 真被解析成文字、
 * 退出码跟着远端结果走。
 *
 * 用法：`pnpm exec tsx scripts/verify-remote.ts`（或 `node --import tsx ...`）
 */
/*
 * 2026-10-21：`strata`（本机假服务）已从**出厂 provider 表**移除 —— 出厂只剩 DeepSeek。
 * 它只在 `DING_ACCEPT_PROVIDERS=1` 时注册；这个脚本是验收/评测工具，自己打开。
 */
process.env.DING_ACCEPT_PROVIDERS ??= "1";

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { startFakeProvider } from "../engine/eval/fakeProvider";

const bad: string[] = [];
const note = (m: string) => console.log("   " + m);

/** 跑一条命令，收回它的 stdout/stderr 与退出码。 */
function run(cmd: string, args: string[], env: NodeJS.ProcessEnv, timeoutMs = 120_000): Promise<{ code: number | null; out: string; err: string }> {
  return new Promise((resolve) => {
    /* ⚠️ Windows 上 npx 是 .cmd —— shell:false 会 ENOENT（实测） */
    const child = spawn(cmd, args, { env, shell: true });
    let out = "";
    let err = "";
    child.stdout.on("data", (d: Buffer) => (out += d.toString("utf8")));
    child.stderr.on("data", (d: Buffer) => (err += d.toString("utf8")));
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, out, err });
    });
  });
}

/*
 * ⚠️ 先构建 CLI（[cli] 编译（tsc -p tsconfig.cli.json）…
[cli] ✓ dist-cli/ 就绪，入口 dist-clihostscliding.js（第一行 #!/usr/bin/env node））—— 这个验收故意**不走 tsx**：
 * 走 tsx 时进程收尾会撞 libuv 断言（tsx 自己的句柄问题），而那与产品无关。
 * 产品路径 = 编译后的 JS（）与单二进制，它们干净。
 */
const build = await run("node", ["scripts/build-cli.mjs"], process.env);
if (build.code !== 0) {
  console.error("✗ 构建 CLI 失败：" + (build.err || build.out).slice(0, 200));
  process.exit(1);
}

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "dh-remote-"));
const provider = await startFakeProvider([{ say: "远端说：收到你的活儿了" }]);
const port = 18_700 + Math.floor(Math.random() * 200);

const env: NodeJS.ProcessEnv = {
  ...process.env,
  STRATA_BASE_URL: provider.url,
  STRATA_API_KEY: "offline",
  DSH_NO_REAL_MODEL: "1",
  DH_DATA_DIR: dataDir,
};

/*
 * `ding serve` 从**配置**读 provider（它不吃 `--provider`）—— 先写一份配置进临时数据目录
 * （`DH_DATA_DIR` 是 ding.ts 认的那个），别去动用户真正的 `~/.ding`。
 */
const cfg = await run("node", ["dist-cli/hosts/cli/ding.js", "config", "set", "provider", "strata"], env);
if (cfg.code !== 0) {
  console.error("✗ 写配置失败：" + (cfg.err || cfg.out).slice(0, 200));
  await provider.close();
  process.exit(1);
}

/** 起服务（`ding serve` 是前台进程，所以这里 spawn 它、用完杀）。 */
const server = spawn("node", ["dist-cli/hosts/cli/ding.js", "serve", "--port", String(port), "--token", "s3cret"], {
  env,
  shell: true,
});
server.stderr.on("data", (d: Buffer) => {
  const line = d.toString("utf8");
  if (/错|失败|Error/i.test(line)) console.error("[serve] " + line.trim().slice(0, 200));
});

try {
  // 等服务起来（healthz 不需要 token）
  const url = `http://127.0.0.1:${port}`;
  let up = false;
  for (let i = 0; i < 40 && !up; i += 1) {
    await new Promise((r) => setTimeout(r, 500));
    try {
      const res = await fetch(`${url}/healthz`);
      up = res.ok;
    } catch {
      /* 还没起来 */
    }
  }
  if (!up) throw new Error("ding serve 没起来");

  const cli = ["dist-cli/hosts/cli/ding.js"];

  // ① 没 token：必须被拒（401），且给的是"要 token"这句人话
  const denied = await run("node", [...cli, "connect", url, "随便说说"], env);
  if (!denied.err.includes("401") && !denied.err.includes("token")) {
    bad.push(`没带 token 时应当被拒并说明要 token，实际：${(denied.err || denied.out).slice(0, 120)}`);
  } else note(`没 token → 被拒且说明 ✓`);

  // ② 带 token 跑一轮：流式打出远端那句话，退出码 0
  const ok = await run("node", [...cli, "connect", url, "把这句话跑一遍", "--token", "s3cret"], env);
  if (ok.code !== 0) bad.push(`带 token 跑一轮应当成功，实际退出码 ${ok.code}：${(ok.err || ok.out).slice(0, 200)}`);
  /*
   * ⚠️ 判据是**流里真有正文**，不是某个特定字符串：回什么字由假 provider 的脚本决定
   * （装置细节），客户端要保证的是 SSE 被解成正文、边收边打。
   */
  if (!ok.out.includes("（子智能体收尾）") && !/▸|收到|你好/.test(ok.out)) {
    bad.push(`没看到远端回复的正文：${ok.out.slice(0, 200)}`);
  }
  if (!ok.out.includes("远端")) bad.push("没打出「对面是谁」那几行（provider / 档位 / 工作目录）");
  note(`带 token → 退出码 ${ok.code}，正文与"对面是谁"都在 ✓`);

  // ③ `--sessions`：那边还没有会话也应当正常返回
  const list = await run("node", [...cli, "connect", url, "--token", "s3cret", "--sessions"], env);
  if (list.code !== 0) bad.push(`--sessions 应当成功，实际 ${list.code}：${(list.err || list.out).slice(0, 160)}`);
  else note(`--sessions → 退出码 0 ✓`);

  // ④ 连不上的地址：错误要是"连不上"而不是崩栈
  const dead = await run("node", [...cli, "connect", "127.0.0.1:1", "喂"], env, 60_000);
  if (dead.code === 0) bad.push("连不上的地址应当以非 0 退出");
  if (!/连不上|fetch failed/i.test(dead.err + dead.out)) bad.push(`连不上时的说明不友好：${(dead.err || dead.out).slice(0, 160)}`);
  else note(`连不上 → 说清了（退出码 ${dead.code}）✓`);
} catch (e) {
  bad.push("异常: " + String((e as Error)?.message ?? e).slice(0, 200));
} finally {
  server.kill();
  await provider.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
}

if (bad.length) {
  console.error("✗ 远端客户端：" + bad.join("；"));
  process.exit(1);
}
console.log("✓ 远端客户端成立：info / 401 要 token / SSE 流式正文 / --sessions / 连不上的说明");
/*
 * ⚠️ 显式退出：serve 是 shell 包出来的子进程，kill() 只杀掉外壳，
 * 留下的管道会让本进程永远不退出（实测——第一次跑就是卡在这儿）。
 */
process.exit(0);
