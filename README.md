# Ding Harness

[![CI](https://github.com/johnGriffith461/DingHarness/actions/workflows/ci.yml/badge.svg)](https://github.com/johnGriffith461/DingHarness/actions/workflows/ci.yml)

> AI 工作台 + 无限画布 —— 一个本机优先的桌面 Agent 工作台
>
> *A local-first desktop agent workbench: AI workspace + infinite canvas.*

Ding Harness 是一个 Electron 桌面应用，把「对话式 Agent」和「无限画布」放在同一个工作台里。
它本机运行、本机存数据，模型走你自己配置的 OpenAI 兼容通道——不依赖任何后端服务。

> 状态：**v0.3.0，早期版本**。目前仅提供 Windows 构建。

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
pnpm build   # → release/ding-harness-0.3.0-setup.exe
```

### 配置模型

模型走 OpenAI 兼容接口，内置五个 provider：DeepSeek 官方、tokenrhythm 中转、apihub 中转、通义千问、本地端点。
密钥按以下优先级读取：

1. 环境变量
2. `~/.dsh/.credentials.yaml`

设置页有连通性探测，用来区分「配了密钥」和「密钥真的可用」。

## 架构

**内核 + 双宿主**：agent 逻辑住在 `engine/`，桌面与命令行都只是它的宿主。

```
engine/                       内核（不 import electron —— 有守卫盯着）
├─ core/       纯逻辑，零 IO、零 Electron —— 可整包单测
│   ├─ events.ts     ★ 事件溯源：state = fold(events)；日志即真相
│   ├─ context.ts    上下文规划器（唯一切分 + 用量校准）
│   ├─ policy.ts     审批闸门判定（run / ask / hide）
│   ├─ assembly.ts   系统提示词装配
│   ├─ notices.ts    错误回注三件套（未知工具 / 闸门拦截 / 执行失败，单一来源）
│   ├─ ledger.ts     成本账本（从事件流现算，不另存统计）
│   └─ snapshot.ts   快照：重放 diff（重构零漂移的验收器）
├─ runtime/    编排层
│   ├─ loop.ts       ★ 唯一的主循环（streamText + stepCountIs）
│   ├─ subagent.ts   子智能体（独立上下文、成本上卷、审批穿透）
│   ├─ registry.ts   工具注册表（builtin / MCP / 插件三来源）
│   ├─ providers.ts  provider 表（baseURL 惰性读环境变量）
│   └─ tools/        与宿主无关的文件工具（read/write/edit/exec/search）
├─ ports/      宿主适配接口：store / health / executor
├─ adapters/   SQLite 事件存储（node:sqlite：CLI 与桌面**同一份实现**）
└─ index.ts    createEngine(ports) → { run, resume, replay, record }

hosts/
├─ cli/ding.ts     命令行宿主：run / sessions / record / replay / models
└─ （桌面宿主在 electron/：窗口与各 store；跑一轮也走 createEngine）

electron/      桌面宿主：窗口、IPC、各 store（JSON 落盘）、MCP 连接器
               ├─ 会话事件 → engine 的 SQLite 库（userData/sessions.db）
               └─ 启动时把旧 sessions/*.jsonl 一次性迁进来（只读旧、写新、不删旧）
shared/        跨宿主契约：ipc.ts（含档位词表）/ agentTools.ts（工具声明）/ mcp.ts
src/           渲染进程（React 19 + zustand + Vite）
```

几条刻意的设计约束（写进 code review 口径）：

- **状态 = fold(events)**：会话、待办、用量全部由事件流折叠得出 —— 可重放、可恢复。
- **日志即真相**：界面是事件流的投影，不是第二个真相。
- **错误即结果**：工具失败 / 未知工具 / 闸门拦截，统一作为 tool result 回注，不中断循环。
- **单一事实来源**：主循环、上下文切分、提示词装配、工具注册、闸门判定各只有一处实现。
- **不编**：拿不到 `usage` 就留空；不知道模型上下文上限就不硬编。

## 命令行

`ding` 是**正式的命令行宿主**，不是"桌面的附属开关"：它跟桌面跑同一个内核、同一套闸门。

```bash
pnpm ding                                      # 不给参数 = 进交互模式（上下文接着上一句）
pnpm ding run "把 demo 里的 md 整理成一份纪要" --dir ./demo
pnpm ding sessions [--json|--export <id>]      # 列会话 / 导出 JSONL
pnpm ding sessions --cost [--by session|day|model]   # 成本账本（数字只来自 provider 上报）
pnpm ding models [--json]                      # provider 与模型（逐条标出数据来源与是否过期）
pnpm ding agents                               # 内置专家（AgentSpec）
pnpm ding eval [类别] [--json]                 # 离线评测集（不烧 token，可进 CI）
pnpm ding eval --update-baseline               # 落一份通过率基线（进版本库）
pnpm ding plugins list|install|enable|disable|remove|doctor
pnpm ding config [show|set <键> <值>|unset <键>] # 默认 provider / 模型 / 档位 / 目录
```

交互模式里的斜杠命令：`/model` `/mode` `/provider` `/agents` `/sessions` `/help` `/exit`。

**配置与优先级**（`~/.ding/config.json`，也读无扩展名的 `~/.ding/config`）：

```
命令行显式参数  >  环境变量（DH_PROVIDER / DH_MODEL / DH_MODE / DH_DIRS）  >  配置文件  >  内置默认
```

数据目录默认 `~/.ding`（`DH_DATA_DIR` 可覆盖）；`--dir` 可重复给（就是桌面的"工作区授权"）。
`--json` 给脚本/CI 用；`--dev` 会多出两个**工程模式**命令（`record` / `replay`，验收驱动器）。

装成全局命令：`node scripts/install-cli.mjs`（默认只构建并打印怎么装；加 `--link` 才真装）。

## 开发与验收

```bash
pnpm typecheck   # tsc --noEmit
pnpm lint        # oxlint
pnpm test        # vitest（内核测试在 engine/**/*.test.ts，与渲染层共跑一个 node 环境）
```

`scripts/accept/` 下是浏览器端验收脚本，`scripts/verify-*.mjs` 是产物与打包校验。

## 已知边界（v0.3.0）

- 仅 Windows 构建；macOS / Linux 尚未验证。
- `run_command` 与用户同权限运行，**没有沙箱**。
- 只有 OpenAI 兼容一种 provider 通道（协议分层在 Phase 5/6 才做）。
- 桌面与 CLI 都已跑在新内核上；两者的会话事件存在同一个 SQLite 库里（各自的数据目录）。
- 旧 JSONL 数据会在启动时自动迁移；迁移**不删**旧文件。
- **插件**（Phase 8）：npm 包或本地目录两种渠道，装之前要你确认权限清单。
  ⚠️ 权限分两类，界面上分开说：`tools:register` / `hooks:register` **真的生效**（不批就不接那根线）；
  `fs:read` / `fs:write` / `net` / `exec` 在 v1 **拦不住**（插件与宿主同进程同权限）——
  它们是"知情"不是"限制"，真正的隔离（Worker / 容器）列 v2。
- **多 agent 协作**（Phase 7）：coordinator 拆任务，几个专家（researcher / writer / runner）并行办。
  每个专家的工具白名单与闸门档位在 `engine/runtime/agents.ts` 里声明；档位**只能更严，不能更松**。
- 模型目录表目前只登记了少数几个模型；未登记模型走保守默认并在账本上标注"未登记模型"。

## 许可

[MIT](./LICENSE)
