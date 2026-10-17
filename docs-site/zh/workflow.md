# 多 agent 工作流

有依赖的多 agent 流水线：先调研 → 再实现 → 再审阅。同一层里的步骤并行，
上一层的结果会拼进下一层的任务描述。运行在 CLI，桌面是**只读泳道 + 续跑入口**。

## 定义

```json
{
  "name": "周报流水线",
  "steps": [
    { "id": "research", "agent": "researcher", "task": "收集本周数据" },
    { "id": "design", "agent": "architect", "task": "给出周报大纲" },
    { "id": "write", "agent": "writer", "task": "写成周报", "dependsOn": ["research", "design"] },
    { "id": "review", "agent": "reviewer", "task": "审阅并挑错", "dependsOn": ["write"] }
  ]
}
```

- `id` 唯一；`dependsOn` 必须指向存在的步骤；**不许成环**（`validate` 会报）；
- `agent` 用内置专家（`ding agents` 看名单）；写错名字会如实失败，不会静默换人；
- 上游步骤的摘要会自动拼进下游任务（"上游结果：…"）。

## 跑

```bash
ding workflow validate weekly.json
ding workflow run weekly.json
ding workflow run weekly.json --out ./weekly-run.json
ding workflow list
ding workflow show <运行 id>
```

中断（Ctrl+C）只会把这一层收尾并落检查点（状态 `paused`），再按一次强制退出：

```bash
ding workflow run --resume ./weekly-run.json
ding workflow run --resume ./weekly-run.json --retry-failed   # 上次失败的也重试
```

**已完成的步骤不会重跑**；失败的步骤按依赖级联跳过（不会假装整条流水线跑完）。

## 桌面可视化

侧栏「工作流」页：按依赖分层的泳道、每步状态/错误、运行进度；
`paused`/`failed` 的运行给出续跑命令（可复制）。定义也可以在那一页保存到
`<数据目录>/workflows/`。

⚠️ **开始按钮不在桌面**：运行需要在主进程再装配一套引擎与凭据，与 CLI 那条必然漂。
这一页只做"看 + 存定义 + 给命令"。

## 边界

- 每一层是一次 `runTeam`：工具/闸门/委派规则与普通对话同一套；
- 步骤失败不会自动重试（要重试用 `--retry-failed` 显式续跑）；
- 中断粒度是"层"：正在跑的那一层会等 provider 响应或 abort 后回到 pending；
- 没有做定时触发/条件分支/循环 —— 那会是另一套 DSL，先把"线性依赖 + 并行层"做扎实。
