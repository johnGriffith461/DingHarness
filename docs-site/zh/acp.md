# ACP：两个方向都能跑

ACP（Agent Client Protocol）是编辑器/宿主与 agent 之间的标准接口，JSON-RPC 2.0 over stdio。
Ding **两个方向都实现了**：

| 方向 | 命令 | 说明 |
|---|---|---|
| 别人驱动 Ding | `ding acp` | Ding 作为 agent，被 OpenHands/编辑器当子进程起起来 |
| Ding 驱动别人 | `ding acp-drive --cmd … --prompt …` | Ding 作为 client，把任务交给外部 ACP agent |

## 驱动外部 agent

```bash
ding acp-drive --cmd node --arg ./my-agent.mjs --prompt "把报表整理一下" --cwd .
ding acp-drive --cmd claude-code-acp --prompt "解释这个仓库的启动流程" --timeout 600000
```

- `--arg` 可重复：外部命令自己的旗标（`--foo`）用 `--arg --foo` 传，不会被 Ding 的解析吃掉；
- 正文流式打到 stdout；工具调用状态打到 stderr；
- 退出码：`end_turn` → 0；`cancelled` / 其它 → 1（"没跑完"不该假装成功）。

## 为什么这对生态重要

"本地优先的 ACP 控制台"：你可以用 Ding 管自己的 agent，也可以把活派给任何 ACP agent，
事件流、审批与账本仍在 Ding 这一侧。

## 远程 ACP（如实说）

ACP 官方远程传输还是 WIP。Ding 的补位是**已有的 E2EE 中继**：

- 控制流（审批/接管）明文、可路由、可审计；
- 内容流（提示词/回复/工具结果）AES-256-GCM，中继只见密文；
- `pnpm e2ee:demo` 是可复现的证明。

`ding acp-drive` 目前只做 **本地 stdio**（协议今天就能跑的那一半）；
远程那条走 `ding serve` + 中继，不是这一个命令。

## 边界

- 外部 agent 的能力（工具、审批）由它自己决定，Ding 不替它兜底；
- 没有沙箱：子进程以你的身份运行；
- 协议版本只声明 1；对端的 `stopReason` 取值按字符串透传（不认识的也如实显示）。
