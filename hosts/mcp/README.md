# hosts/mcp —— 把画布交给外部 MCP 客户端

**画布 MCP server**（V5-4 任务 4.5）：把画布工具族（C6）按
[Model Context Protocol](https://modelcontextprotocol.io) 的形状暴露出去 ——
别人的 agent / 编辑器 / 脚本都能**驱动这张画布**，不必懂这个产品的内部结构。

```
外部 MCP 客户端 ──stdio(JSON-RPC 2.0，一行一条)──▶ canvasServer.ts ──▶ <数据目录>/canvas/document.json
```

## 怎么接

MCP 客户端的配置里加一条（`command` 是起 server 的方式）：

```json
{
  "mcpServers": {
    "ding-canvas": {
      "command": "node",
      "args": ["--import", "tsx", "<本仓>/hosts/mcp/canvasServer.ts"],
      "env": { "DH_DATA_DIR": "C:/Users/你/.ding" }
    }
  }
}
```

- 数据目录走与桌面/CLI **同一套**口径：`DH_DATA_DIR` > `DSH_CANVAS_DATA_DIR` > `~/.ding`。
  指到与桌面同一个目录，就是在改**你正在看的那张画布**（桌面重启/刷新后可见）。
- 手跑一下看协议：`DH_DATA_DIR=/tmp/x npx tsx hosts/mcp/canvasServer.ts`，
  然后往 stdin 打一行 `{"jsonrpc":"2.0","id":1,"method":"tools/list"}`。

## 支持什么

| JSON-RPC 方法 | 说明 |
|---|---|
| `initialize` | 握手（协议版本 `2024-11-05`，`serverInfo.name = ding-canvas`） |
| `ping` | 空回应 |
| `tools/list` | 工具面 —— **从 `engine/core/canvasContract.ts` 那张表读**，不在这里重抄 |
| `tools/call` | 执行（目前是 `canvas_add_node`） |
| `notifications/*` | 不回（JSON-RPC 的规矩：通知不需要结果） |

工具面的**判定**与产品里那一份是同一个出处：`canvas_add_node` 属于 `create` surface，
在「按需确认」档下是 `ask`。MCP 这边**不许比策略表宽松** ——
那张表是唯一的来源，加了新工具先在 `CANVAS_TOOL_OPS` 登记。

## 边界（如实说）

- 这一版驱动的是**磁盘上那份 `CanvasDocument`**（与桌面同一个文件、同一个格式）。
  **不是热协作**：桌面正打开同一张画布时，两边各写各的（后写的赢，`revision` 会跳）。
  把它接进事件流（真正的协作）是 V5-3 的方向，不是这个示范假装做完的事。
- 只有 `canvas_add_node` 一个工具（C6 里**已经实现**的那一个）。加工具的顺序：
  先 `CANVAS_TOOL_OPS` 登记 → 再在这里给 MCP 的声明。
- stdout 是协议通道：往里写任何非 JSON 的东西都会让客户端解析失败（日志一律走 stderr）。

## 验收

```bash
pnpm verify:canvas-mcp     # 真起 server、真当客户端、真读盘（数据目录是临时目录）
```

单测那一半（改画布的规则 + 协议边界）在 `hosts/mcp/canvasMcp.test.ts`。
