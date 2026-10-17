# IM 身份接入（飞书 / Slack）

让 bot **以自己的身份**进群：接平台 webhook → 验签去重 → 交给 Ding 跑一轮 →
用 bot 身份把回复发回群里。

## 三步

### 1. 起 Agent Server

```bash
ding serve --port 8787 --token <口令>
```

### 2. 写 `im.json`（数据目录下；凭据只放这里）

```json
{
  "agent": { "url": "http://127.0.0.1:8787", "token": "<上面的口令>" },
  "feishu": {
    "appId": "cli_xxx",
    "appSecret": "xxx",
    "verificationToken": "xxx",
    "encryptKey": "xxx"
  },
  "slack": { "signingSecret": "xxx", "botToken": "xoxb-xxx" },
  "allowUsers": ["ou_你的open_id"],
  "loopbackOnly": true
}
```

至少配一个平台。`allowUsers` **强烈建议填**：bot 进了群，群里任何人都能 @ 它，
而它用的是你的机器、你的密钥、你的目录。

### 3. 起桥并接平台

```bash
ding im status
ding im serve --port 8790
```

- 飞书：开发者后台 → 事件订阅 → 请求地址填 `https://<你的域名>/im/feishu`，
  订阅 `im.message.receive_v1`，开通 `im:message`（发消息）权限；
- Slack：App → Event Subscriptions → Request URL 填 `https://<你的域名>/im/slack`，
  订阅 `message.channels` / `message.im`，Bot Token 要有 `chat:write`。

本机只绑 `127.0.0.1`；公网用 Caddy/Nginx 或隧道转发到 8790。
平台签名就是这一层的认证 —— **不要**把它挂到 `ding serve` 上（那条服务要求 Bearer，
平台带不了）。

## 它怎么保证不重复、不乱来

| 机制 | 作用 |
|---|---|
| 验签 | 飞书 `sha256(ts+nonce+key+body)`（配了 encryptKey 才要求）；Slack `v0=HMAC` + ±5 分钟 |
| 解密 | 飞书加密事件 AES-256-CBC（key=sha256(encryptKey)） |
| 去重 | `im-seen.json` 记最近 1000 个 event_id；**ACK 前就落盘**，平台重投不会重复执行 |
| 先 ACK | 平台要求几秒内 200，agent 可能跑几分钟——先回 200，再异步处理 |
| 白名单 | `allowUsers` 之外的人：不回、也不问 agent |
| 失败也回 | agent 失败时回一句"我这轮没跑完：原因"，不沉默 |

## 与 V5-3.6 渠道触发器的关系

那个是**外面有个桥**（Telegram bot/自建脚本）把消息翻成 `POST /v1/channels/<渠道>`；
这一层是 Ding **自己就是那个桥**。两者最终都走同一条 `/v1/channels` 出口，
所以事件流、账本、审批不会分叉。

## 边界

- 只做了飞书与 Slack；微信/QQ 需要各自的应用审核与协议，未做；
- 群聊里所有消息都会触发（没有做"只在 @ 时"的过滤，靠平台订阅范围与白名单控制）；
- 没有附件/图片消息（只处理文本）；
- 平台凭据只存在 `im.json`，不写日志、不进库。
