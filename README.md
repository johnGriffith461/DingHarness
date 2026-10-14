# Dingwork

> AI 工作台 + 无限画布 —— 一个本机优先的桌面 Agent 工作台
>
> *A local-first desktop agent workbench: AI workspace + infinite canvas.*

Dingwork 是一个 Electron 桌面应用，把「对话式 Agent」和「无限画布」放在同一个工作台里。
它本机运行、本机存数据，模型走你自己配置的 OpenAI 兼容通道——不依赖任何后端服务。

> 状态：**v0.1.0，早期版本**。目前仅提供 Windows 构建。

---

## 功能

- **Agent 工具面**：13 个内置工具——记忆（`memory_save` / `memory_list`）、定时任务（`schedule_create` / `schedule_list`）、画布（`canvas_add_node`），以及文件类 `list_files` / `read_file` / `write_file` / `list_dir` / `search_files` / `edit_file`、`run_command`，加一层子智能体 `spawn_agent`。
- **连接器（MCP）**：以 stdio 子进程接入 MCP server（最多 8 个），工具以 `mcp__<server>__<tool>` 暴露给模型。
- **审批闸门**：三档模式（全部允许 / 按需确认 / 每步确认）；每个工具按读/写分级，MCP 工具默认按写对待；被拦下的调用可就地允许或拒绝，决策写入会话日志。
- **子智能体**：独立上下文、只回要点报告、token 成本上卷父级；共用同一张闸门表，不穿透审批。
- **上下文管理**：唯一的切分点，只在消息边界切、保留段以 user 开头、最后一条必留；用 provider 返回的真实 `usage` 校准估算系数。
- **会话日志**：界面状态由事件投影（`applyEvent`）生成，与日志同源——历史从日志恢复。
- **工作区授权**：经系统对话框授权真实目录（渲染进程无法注入路径），最多 8 个、可随时撤销；文件类工具与 `run_command` 全部收敛到白名单。
- **产物**：对话里的 `<artifact>` 会被提取成卡片并落盘；支持真 Office 格式（docx / pptx / xlsx，真 ZIP 容器）。
- **工作台**：任务、检查点、长期记忆、定时任务、技能/插件面板、AI 文档、主题系统；无限画布节点支持 markdown / code / image / whiteboard。

## 技术栈

Electron 44 · React 19 · zustand · Vite 7 · React Flow v12 · Vercel AI SDK v7 · zod · TypeScript 5.9 · pnpm

## 快速开始

环境要求：Node ≥ 20（实测 v24）、pnpm ≥ 10、Windows。

```bash
pnpm install
```

开发（两个终端）：

```bash
# 终端 1：Vite 开发服务器 → http://localhost:5173
pnpm dev:web

# 终端 2：编译主进程并启动 Electron
pnpm electron:build && pnpm exec electron .
```

打包（含 typecheck / lint / test 全门禁）：

```bash
pnpm build   # → release/Dingwork-0.1.0-setup.exe
```

### 配置模型

模型走 OpenAI 兼容接口，内置五个 provider：DeepSeek 官方、tokenrhythm 中转、apihub 中转、通义千问、本地端点。
密钥按以下优先级读取：

1. 环境变量
2. `~/.dsh/.credentials.yaml`

设置页有连通性探测，用来区分「配了密钥」和「密钥真的可用」。

## 架构

```
渲染进程 (React 19 + zustand + Vite)
  ├─ src/workbench/   工作台        ├─ src/canvas/  无限画布
  └─ src/ai/          侧栏对话
        │  preload 桥（contextIsolation）
主进程 (Electron)
  ├─ electron/ipc/runTurn.ts   ★ 唯一的 Agent 主循环（streamText + stepCountIs）
  ├─ electron/ipc/tools.ts     工具执行绑定
  ├─ electron/ipc/mcpClient.ts MCP 连接器
  └─ 其余 store（JSON 落盘）
shared/  ← 渲染与主进程共用的唯一事实来源
  ├─ agentTools.ts   工具声明（zod schema = 给模型的说明 + 执行前校验）
  ├─ sessionLog.ts   ★ 事件投影：界面与日志同一份真相
  ├─ contextWindow.ts★ 上下文唯一切分 + 用量校准
  ├─ permissions.ts  ★ 审批闸门（run / ask / hide）
  └─ turnAssembly.ts 系统提示词装配
```

几处刻意的设计约束：

- **单一事实来源**：Agent 主循环、上下文切分、系统提示词装配、界面状态各自只有一处实现。
- **错误回注上下文**：工具校验失败、闸门拦截都作为 tool result 回到模型，而不是抛栈。
- **不编数据**：拿不到 `usage` 就留空，不知道模型上下文上限就不硬编。

## 开发与验收

```bash
pnpm typecheck   # tsc --noEmit
pnpm lint        # oxlint
pnpm test        # vitest
```

`scripts/accept/` 下是浏览器端验收脚本，`scripts/verify-*.mjs` 是产物与打包校验。

## 已知边界（v0.1.0）

- 仅 Windows 构建；macOS / Linux 尚未验证。
- `run_command` 与用户同权限运行，**没有沙箱**。
- 只有 OpenAI 兼容一种 provider 通道。
- 无 headless / CLI 入口；扩展途径只有 MCP 客户端。
- 尚无插件机制：能力来自内置工具与 MCP。

## 许可

[MIT](./LICENSE)

## 说明
