/**
 * `ding im` —— 平台 bot 身份桥（V6-2f）。
 *
 * ```
 * ding im serve [--port 8790] [--config <文件>]
 * ding im status
 * ```
 *
 * 它自己接平台 webhook（飞书/Slack），验签、去重，把消息交给
 * `ding serve` 的 `/v1/channels/<平台>`，再以 **bot 身份**把回复发回去。
 *
 * ⚠️ 平台侧还要把 webhook 地址指过来（反向代理/隧道），见 `docs-site/zh/im.md`。
 */
import path from "node:path";

import { imConfigFile, loadImConfig } from "../../engine/im/config";
import { createImServer } from "../../engine/im/server";
import { flag, parseIntFlagValue, type Parsed } from "./args";

export async function cmdIm(p: Parsed, dataDir: string): Promise<number> {
  const sub = p.args[0] ?? "status";
  const file = flag(p, "config") ?? imConfigFile(dataDir);
  const loaded = loadImConfig(path.resolve(file));
  if (!loaded.ok) {
    process.stderr.write(`${loaded.error}\n`);
    return 2;
  }
  const config = loaded.config;

  if (sub === "status") {
    process.stdout.write(
      `配置：${loaded.file}\n` +
        `  平台：${[config.feishu ? "feishu" : "", config.slack ? "slack" : ""].filter(Boolean).join(" / ")}\n` +
        `  Agent：${config.agent.url}\n` +
        `  白名单：${config.allowUsers?.length ? config.allowUsers.join(" / ") : "（未设置 —— 群里任何人都能用你的机器）"}\n` +
        `  绑定：${config.loopbackOnly === false ? "0.0.0.0（对公网，风险自负）" : "127.0.0.1（默认）"}\n`,
    );
    return 0;
  }

  if (sub !== "serve") {
    process.stderr.write("用法：ding im serve|status [--port 8790] [--config <文件>]\n");
    return 2;
  }

  const port = parseIntFlagValue(flag(p, "port"), "port", { min: 1, max: 65535, fallback: 8790 });
  if (!port.ok) {
    process.stderr.write(`${port.message}\n`);
    return 2;
  }
  const bind = config.loopbackOnly === false ? "0.0.0.0" : "127.0.0.1";

  const im = createImServer({
    config,
    seenFile: path.join(dataDir, "im-seen.json"),
  });
  await new Promise<void>((resolve, reject) => {
    im.server.once("error", reject);
    im.server.listen(port.value, bind, () => resolve());
  }).catch((error: unknown) => {
    process.stderr.write(`起不来：${String((error as Error)?.message ?? error)}\n`);
  });
  if (!im.server.listening) return 1;

  process.stdout.write(
    `✓ IM 桥已起：http://${bind}:${im.port()}\n` +
      `  webhook：/im/feishu${config.feishu ? "" : "（未配）"}　/im/slack${config.slack ? "" : "（未配）"}\n` +
      `  健康检查：GET /healthz\n` +
      `  ⚠️ 对公网暴露请走反向代理/隧道，并把平台的事件订阅指到它。\n`,
  );
  for (const warning of warningsOf(config)) process.stderr.write(`⚠️ ${warning}\n`);

  await new Promise<void>((resolve) => {
    const stop = () => {
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
      process.stdout.write("\n收尾中…\n");
      void im.close().then(resolve);
    };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
  });
  return 0;
}

/** 启动时的风险提示（不拦着跑，只把话说清）。 */
function warningsOf(config: { allowUsers?: string[]; loopbackOnly?: boolean }): string[] {
  const out: string[] = [];
  if (!config.allowUsers?.length) out.push("没有配 allowUsers：群里任何人都能让 bot 用你的机器做事（建议填白名单）");
  if (config.loopbackOnly === false) out.push("绑定在 0.0.0.0：确保前面有 TLS/反向代理与平台签名校验，别直接暴露");
  return out;
}
