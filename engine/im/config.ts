import fs from "node:fs";
import path from "node:path";

import type { FeishuConfig } from "./feishu";
import type { SlackConfig } from "./slack";

/**
 * IM 桥配置（V6-2f）。
 *
 * 落在 `<数据目录>/im.json`，**凭据只在这一个文件里**（不写进配置/日志）。
 * 与 `ding serve` 的口令同一条纪律：不配就不启用对应平台。
 */

export type ImConfig = {
  /** Agent Server（`ding serve`）。 */
  agent: { url: string; token: string };
  feishu?: FeishuConfig;
  slack?: SlackConfig;
  /**
   * 允许的终端用户 id（空/不填 = 不限制）。
   *
   * ⚠️ 强烈建议填：bot 进了群，群里任何人都能 @ 它 —— 而它会用**你的**机器、
   * **你的**密钥、**你的**目录做事。白名单是这里最便宜也最有效的一道门。
   */
  allowUsers?: string[];
  /** 只监听回环（默认 true；对公网暴露请走反向代理/隧道，不要直接 0.0.0.0）。 */
  loopbackOnly?: boolean;
};

export type ImConfigLoad = { ok: true; config: ImConfig; file: string } | { ok: false; error: string; file: string };

/** 默认配置文件位置。 */
export function imConfigFile(dataDir: string): string {
  return path.join(dataDir, "im.json");
}

function asString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * 读并收窄配置（**磁盘不可信**；坏字段报出来，不静默半启用）。
 */
export function loadImConfig(file: string): ImConfigLoad {
  if (!fs.existsSync(file)) {
    return { ok: false, file, error: `没有配置文件：${file}（照 IM.md 建一份；凭据只放这里）` };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    return { ok: false, file, error: `配置不是合法 JSON：${String((error as Error)?.message ?? error)}` };
  }
  if (!raw || typeof raw !== "object") return { ok: false, file, error: "配置必须是对象" };
  const o = raw as Record<string, unknown>;
  const agent = (o.agent ?? {}) as Record<string, unknown>;
  const url = asString(agent.url);
  const token = asString(agent.token);
  if (!url || !token) return { ok: false, file, error: "缺 agent.url / agent.token（指向 ding serve）" };

  const out: ImConfig = { agent: { url, token } };

  const feishu = (o.feishu ?? null) as Record<string, unknown> | null;
  if (feishu) {
    const appId = asString(feishu.appId);
    const appSecret = asString(feishu.appSecret);
    const verificationToken = asString(feishu.verificationToken);
    if (!appId || !appSecret || !verificationToken) {
      return { ok: false, file, error: "feishu 段缺 appId / appSecret / verificationToken" };
    }
    out.feishu = {
      appId,
      appSecret,
      verificationToken,
      ...(asString(feishu.encryptKey) ? { encryptKey: asString(feishu.encryptKey) } : {}),
      ...(asString(feishu.apiBase) ? { apiBase: asString(feishu.apiBase) } : {}),
    };
  }

  const slack = (o.slack ?? null) as Record<string, unknown> | null;
  if (slack) {
    const signingSecret = asString(slack.signingSecret);
    const botToken = asString(slack.botToken);
    if (!signingSecret || !botToken) return { ok: false, file, error: "slack 段缺 signingSecret / botToken" };
    out.slack = {
      signingSecret,
      botToken,
      ...(asString(slack.apiBase) ? { apiBase: asString(slack.apiBase) } : {}),
    };
  }

  if (!out.feishu && !out.slack) return { ok: false, file, error: "至少配一个平台（feishu / slack）" };
  if (Array.isArray(o.allowUsers)) {
    const users = o.allowUsers.filter((x): x is string => typeof x === "string" && x.trim() !== "").map((x) => x.trim());
    if (users.length) out.allowUsers = users;
  }
  if (o.loopbackOnly === false) out.loopbackOnly = false;
  return { ok: true, config: out, file };
}
