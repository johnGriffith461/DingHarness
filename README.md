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

## 五分钟上手

```bash
# ① 装（两条渠道，选一条）
#    a. 不想装 Node：用单文件可执行（目标机器什么都不用装）
pnpm cli:bin && node scripts/install-cli.mjs --bin
#    b. 已经有 Node：装成全局命令
node scripts/install-cli.mjs --link

# ② 配（交互式向导：配 key → 选模型 → 选工作目录，全程四问）
ding init

# ③ 自检（它会告诉你这台机器上缺什么、下一步做什么）
ding doctor

# ④ 跑一句
ding run "把这个目录里的文件列一遍，说清哪个最可能是配置"
```

装完不放心就先看看它到底会动什么：`ding recipe list`（内置几个常用模板，
`ding recipe show <id>` 看它要发什么提示词、用哪些工具）。

**桌面端**：`pnpm dev:web` + `pnpm electron:dev`（见下），或者直接跑安装包。
第一次打开会带你走同样的向导。

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
├─ server/         HTTP 宿主（`ding serve`）：会话/空间/中继/渠道
└─ mcp/            画布 MCP server：把画布工具族交给**外部 MCP 客户端**（见 hosts/mcp/README.md）

packages/          SDK：engine-core（事件 + 主循环，无 IO）/ engine（完整能力面）
examples/sdk-turn/ 10 分钟跑通一轮的两个示例（完整面 / 最小面）

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
pnpm ding providers list|add|remove …          # 自定义 provider（端点/协议/密钥引用，进 config.json）
pnpm ding schedule add "每天 9 点" --title <名> --prompt <任务>  # 定时任务（与桌面共用 schedules.json）
pnpm ding schedule run-due --every 1           # 常驻执行（关掉终端才停）
pnpm ding agents                               # 内置专家（AgentSpec）
pnpm ding eval [类别] [--json] [--repeat <k>]  # 离线评测集（不烧 token；--repeat = pass@k）
pnpm ding eval --update-baseline               # 落一份通过率基线（进版本库）
pnpm ding bench list|run [suite]               # 任务级公开基准（判产物；见 BENCHMARKS.md）
pnpm ding fork <会话 id> [--at-turn N|--at-seq N] [--into <新id>] [--list]  # 从任一时点分叉
pnpm ding worktree start|list|merge|remove <名字>   # git 工作树隔离改动，改完合回主树
pnpm ding knowledge add <文件|目录> [--domain private|team]  # 本地知识库（FTS，带引用）
pnpm ding knowledge search <词> [--limit n]        # 检索并给出「标题 + 路径 + 第几段」
pnpm ding knowledge ask <问题>                     # 真模型 + 引用（会花钱）
pnpm ding doctor [--json]                      # 一键自检（每项失败都给下一步）
pnpm ding init                                 # 首次配置向导（配 key / 选模型 / 选目录）
pnpm ding resume [<会话 id>] [--continue]      # 崩溃恢复（看被打断的回合 / 接着跑完）
pnpm ding sessions --search <词>               # 本地全文检索（FTS + 子串）
pnpm ding backup [--out <文件>]                # 全量备份（会话 + 配置，单个 JSON，不含密钥）
pnpm ding restore <文件> [--list]              # 从备份恢复（只补不覆盖）
pnpm ding recipe list|show|run|export|import   # 任务模板（可分享）
pnpm ding serve [--port 8787]                  # Agent Server（REST + SSE；默认只绑回环）
pnpm ding acp                                  # 作为 ACP agent 跑在 stdio 上（被外部宿主驱动）
pnpm ding acp-drive --cmd <可执行> --prompt "…"  # 反过来：Ding 驱动外部 ACP agent
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

## 当 SDK 用（把引擎嵌进你自己的程序）

```bash
npm i ding-engine        # 完整能力面（SQLite + 工具 + 凭据 + 插件）
npm i ding-engine-core   # 最小嵌入面（只有事件 + 主循环，不碰 IO）
```

十分钟那条路在 [`examples/sdk-turn/README.md`](examples/sdk-turn/README.md)；
它有两个**真能跑**的示例（完整面走 SQLite、最小面走内存 store），CI 里每次 push 都会
把两个包打成 tarball、装进干净工程、原样跑一遍（`pnpm verify:sdk`）。

公开面冻结在 `packages/api.frozen.json`（加名字要补清单、删或改签名要 ADR + major），
版本与发布口径见 [`RELEASE.md`](RELEASE.md)。

## 开发与验收

```bash
pnpm typecheck   # tsc --noEmit
pnpm lint        # oxlint
pnpm test        # vitest（内核测试在 engine/**/*.test.ts，与渲染层共跑一个 node 环境）
```

`scripts/accept/` 下是浏览器端验收脚本，`scripts/verify-*.mjs` 是产物与打包校验。

```bash
pnpm eval            # 离线评测集（63 条，六类；不烧 token）
pnpm perf:budget     # perf-budget 实测（数字落 engine/eval/perf-baseline.md）
pnpm cli:bin         # 编单文件可执行（四个平台；Windows 那个可验）
pnpm sandbox:build   # 编命令沙箱（Rust；零外部依赖）
node scripts/verify-acceptances.mjs   # 免模型验收批跑（68 条）
```

**改完东西请顺手跑一次 `pnpm eval`**：它是"行为有没有变"的最快信号。
`pnpm test` 的门是**任何一条产品失败或装置不可达都红**；基线（`engine/eval/baseline.json`）
另外锁住两件事：**用例只增不减**，且基线本身必须记的是 100%（拿半绿的运行去
`--update-baseline` 等于把及格线调低）。

## 写插件

插件是一个目录（manifest + 入口），能力分两类：**`tools:register` / `hooks:register` 真的生效**，
`fs:read` / `fs:write` / `net` / `exec` **只是声明**（v1 拦不住）。
写之前先读 [`PLUGIN.md`](./PLUGIN.md)（含最小可用示例、四个钩子、装/试/卸与两条易忽略的规矩）。

## 平台覆盖（如实标注）

CLI 有**两种装法**，验过的程度不一样 —— 分开说，别混成一句"CLI 跑过"：

| 跑法 | 是什么 | 谁在验它 |
|---|---|---|
| **npm 那条路**（`npm i -g @ding/cli` → `dist-cli/`） | 发布包在 `packages/cli`（`pnpm cli:pkg` 生成），`bin.ding` 指向 `dist-cli/hosts/cli/ding.js`，要目标机器**有 Node**；**尚未发布**（卡在账号 2FA，见 [`packages/cli/PUBLISHING.md`](packages/cli/PUBLISHING.md)） | `pnpm cli:build` + `pnpm cli:pkg:check` + `node scripts/verify-cli-npm.mjs`（在 `pnpm build` 链里，也在 CI 的 `gates` 里） |
| **单二进制那条路**（`dist-bin/ding-<平台>`） | Bun 编出来的单文件，**不需要目标机器装 Node** | `pnpm cli:release`（= `cli:bin` + `verify-cli-bin.mjs`），CI 里是独立一个 `cli-bin` job |
| 开发态 | `pnpm ding`（tsx 直接跑源码） | `pnpm test` 里的引擎/宿主测试 |

| 平台 | 桌面 | CLI（npm 那条路） | CLI（单二进制） | 命令的资源上限 | 密钥加密存储 |
|---|---|---|---|---|---|
| **Windows x64** | ✅ 打包 + 启动验过（`pnpm package:win`） | ✅ 验过：`--help` / `sessions` / `models` / `doctor` / `eval` 63/63，且与源树逐条对照（`node scripts/verify-cli-npm.mjs`） | ✅ 编出来且**跑过**（`pnpm cli:release`：剥掉 PATH 只剩系统目录再跑，`eval` 63/63） | ✅ 作业对象（内存 / 子进程数 / 不留孤儿）；**安装包带着 `ding-sandbox.exe`**（落在 `resources/`，应用自己找得到） | ✅ 桌面走 DPAPI；CLI 无 |
| macOS（x64 / arm64） | ⚠️ 目标配置就位，**没在真机上跑过** | ⚠️ 这条路只验过 Windows（纯 Node，理论上哪都一样，但**没在 macOS 上执行过**） | ⚠️ 编得出来，**没跑过** | ⚠️ 没打进去（只有 Windows 那份进了 `extraResources`） | ⚠️ 桌面可走 Keychain；未验证 |
| Linux x64 | ⚠️ 同上（AppImage / deb），**桌面版没在 Linux 上跑过** | ⚠️ 同上（没在 Linux 上执行过） | ✅ **跑过**：WSL Ubuntu 24.04 里 `--help` / `doctor` / `eval` 63/63（2026-10-16）—— 走的是单二进制那条路 | ⚠️ 同上（没打进去；实现只有 Windows 那份） | ⚠️ 桌面可走 libsecret；未验证 |

**这张表就是"我们验过什么"的清单**：⚠️ 的那些是**能编出来但没在对应系统上执行过**，
不是"已支持"。`ding doctor` 会把当前这台机器上缺的能力逐条列出来。

自动更新**未做**：它需要代码签名证书与一个更新 feed（见 `SAFETY.md` 第五节）。
现在装新版本是手动下载安装包。

## 排错（先跑 `ding doctor`）

| 现象 | 多半是什么 | 怎么弄 |
|---|---|---|
| `没有可用的模型凭据` | 还没配 key | `ding init`，或设环境变量（`DEEPSEEK_API_KEY` 等） |
| `连不上 provider` | 网络 / 本地服务没起 | 本地 provider 要先起服务；远程看代理设置 |
| `密钥无效或已过期` | key 过期 / 抄漏了 | 重新写一次；`ding doctor` 的「模型凭据」会告诉你读到几条 |
| 工具一律报「不在可写范围内」 | 工作目录没配 / 配的目录不存在 | `ding config set dirs <目录>`；`ding doctor` 的「工作目录」那一格会红 |
| 界面上按钮点不动 | 旧构建 | 重新 `pnpm build:web && pnpm electron:build`（验收脚本也会报同一个原因） |
| 上次关窗口时它还在跑，现在那个任务躺着 | 回合被打断（正常现象） | `ding resume` 看有哪些，`ding resume <id> --continue` 接着跑；桌面上那颗「继续」按钮同理 |
| 想找三个月前聊过的内容 | —— | `ding sessions --search <词>`（检索会话正文，不只是标题） |
| 沙箱报「不受限地跑」 | 没编 `ding-sandbox` | `pnpm sandbox:build`（需要 Rust）；不编也能用，只是命令没有资源上限 |

## 多机同步与 E2EE

```bash
ding serve --port 8787 --token <口令> --member bob:<bob 的口令>   # 中继那一台
ding sync <会话 id> --to http://<中继>:8787 --token <口令> --key <房间密钥>
ding sync <会话 id> --to … --every 60                            # 常驻对账
pnpm e2ee:demo                                                   # 现场演示：中继只见密文
```

内容类记录（提示词/回复/工具结果）在**客户端**用 AES-256-GCM 封好再上传；
控制类（审批/接管）明文 —— 零知识与"让云端帮你路由审批"天生不相容（ADR-0014）。
`pnpm e2ee:demo` 会真起一个服务、真推一段会话、把中继出站数据抓下来，验证
**搜不到明文 / 没密钥解不开 / 持钥两端一致**。

## 已知边界

**安全边界逐条写在 [`SAFETY.md`](./SAFETY.md)**（包括"没做的"那一节）—— 这里只列最要紧的：

- **`run_command` 不是安全边界**：Windows 上它有内存与子进程数上限（作业对象），
  但命令仍以**你的身份**运行，能读能写能联网。唯一拦着 `rm -rf` 的是**闸门**（你点的那一下）。
- **插件 v1 的权限只是声明**：`fs:read` / `fs:write` / `net` / `exec` **拦不住**
  （插件与宿主同进程）。`tools:register` / `hooks:register` 是真的（不批就不接那根线）。
  隔离版（wasmtime + 签名）**未做**。
- **密钥**：桌面端「设置 → 密钥」里填的 key 走 `safeStorage`（DPAPI / Keychain / libsecret），
  拿不到系统加密能力时**拒绝写**并说清原因（不退化成明文）；
  **CLI 向导（`ding init`）写的是明文** —— 原因是 CLI 没有系统钥匙串入口
  （`secretsEncrypted()` 恒为 false），不是因为"CLI 不落盘"；它写的是
  `~/.dsh/.credentials.yaml` 里 `refs:` 段自己那一个键（那个文件**桌面与 CLI 共用**，
  别人的键与注释原样保留）；`mode: 0o600` 只在 POSIX 成立，Windows 上没有这层保护。
  「旧明文配置一次性迁移并提示」**没做**（列在 `SAFETY.md` 第五节）。
  备份里**不含密钥**，而且加密是**本机绑定**的（换机器解不开，要重填一次）。
## 连到远端的 agent（Phase 17 的另一半）

`ding serve` 把 agent 挂到 HTTP 上；`ding connect` 是**客户端**：

```bash
ding connect 192.168.1.9:8787                                       # 看看那台机器上是谁、什么档位、工作目录
ding connect 192.168.1.9:8787 "把 D:/报表 里那三个 csv 合成一张表"   # 跑一轮，正文边收边打（SSE）
ding connect 192.168.1.9:8787 --sessions                            # 那边的会话列表
ding connect 192.168.1.9:8787 "..." --token <口令>                    # 远端带 token 时（对外绑定必然要）
```

退出码跟着**远端那一轮**走（成功 0 / 失败 1），所以它能直接写进脚本。

- **多平台**：见上面那张表 —— 桌面只有 Windows x64 验过；**CLI 单二进制**多了一个 Linux
  （WSL Ubuntu 24.04 上真跑过 `eval` 63/63）；**npm 那条路（`dist-cli`）只在 Windows 上执行过**；
  macOS 仍然只有编得出来，**没在真机上跑过**。
- **模型目录表**只登记了少数模型；未登记的走保守默认并在账本上标「未登记模型」。
- 旧 JSONL 数据在启动时自动迁移，**迁移不删**旧文件；
  配置型数据从 Phase 12.1 起默认存 SQLite（`DSH_STORE_BACKEND=file` 可退回文件）。

## 治理、隐私与支持

| 文件 | 内容 |
|---|---|
| [`PRIVACY.md`](./PRIVACY.md) | **默认零遥测**：本机存什么、什么时候联网、怎么删 |
| [`SECURITY.md`](./SECURITY.md) | 漏洞披露（私密渠道）、AI 生成报告政策、已知安全边界 |
| [`GOVERNANCE.md`](./GOVERNANCE.md) | 谁定什么、ADR 流程、不可协商的四条 |
| [`SUPPORT.md`](./SUPPORT.md) | 去哪问、提问带什么、响应预期 |
| [`AGENTS.md`](./AGENTS.md) | 给 agent 协作者的项目说明书（架构地图与规矩） |
| [`BENCHMARKS.md`](./BENCHMARKS.md) | 公开评测/基准成绩、方法论与失败分类 |
| [`CONTRIBUTING.md`](./CONTRIBUTING.md) | 提 PR 的路（四道门、六条规矩） |

## 许可

[Apache-2.0](./LICENSE)（含明确的专利授权；`package.json` 的 `license` 与它是同一件事）
