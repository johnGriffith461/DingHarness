# 变更记录

本文件记**用户可见**的变化，以及每一版"如实记下的边界"。
仓库里每一处"为什么不这么做"的推理写在代码注释里（本项目的口径：注释讲约束与意图，不记流水账）。

## 0.3.0

这一版是**能力扩张**（方案 Phase 5–9）：从"自用工具"走向"平台"。
前置是 0.2.0 的内核换代 —— 没有它，下面每一项都无处落地。

### 新增

- **模型目录表 + provider 协议分层**（Phase 5）
  - 每条模型带协议、上下文、价格、能力，以及**来源与核实日期**；超 90 天标"可能过期"；
    未登记模型走保守默认并在账本上标"未登记模型"（**不编数**）
  - `engine/runtime/protocols/`：OpenAI 兼容 / Anthropic 原生 / Gemini 原生三个适配器；
    **加一家 provider = 加一条配置**。新增 anthropic / google / openai / openrouter 四家
  - 离线 vendor 流程：`pnpm vendor:models` 从仓库里的快照生成目录表（快照与生成物都进版本库）
- **AI SDK 评估门**（Phase 6）：`pnpm poc:sdk` 跑三项指标（缓存可控性 / 工具调用确定性 /
  中止与步数语义），全程打在本地假端点、**不发一次真请求**。结论：保留 AI SDK（选项 A），
  记在 `ADR/0001-sdk-选型.md`
- **多 agent 协作**（Phase 7）
  - agent 定义**数据化**（`engine/runtime/agents.ts`）：名字 / 系统提示 / 工具白名单 / 闸门档位 / 步数
  - `spawn_agents`：一次派几件事给几个专家**并行**办，汇合回一份报告；成本上卷、闸门不穿透
  - 新增 `delegation` 事件：**团队进展能从日志还原**（被打断时"谁还在跑"看得出来）
- **插件系统**（Phase 8）：manifest（权限声明必填）+ 安装台账 + 装载与钩子
  （`session:start` / `tool:before` / `tool:after` / `turn:end`）+ 桌面「外部插件」段
- **CLI 产品化**（Phase 9）：交互模式、配置、`--json`、`--dev`、npm bin 与安装脚本（见 README）

### 变化

- 上下文额度按模型上限算并**封顶**在原值（往上不跟着放大 —— 历史每轮都要重发，
  从 2 万涨到 50 万是**静默的单轮成本 ×25**）
- 主循环的**步数统计修对了**：原来认的是 `finish`（整轮结束），现在是 `finish-step`（每步）。
  在此之前 `maxSteps=3` 的一轮也只报 1 步 —— 这件事单步场景测不出来，是 PoC 逮到的

### 修复

- `ding --json sessions` 会把 `sessions` 当成 `--json` 的值（于是进了交互模式）：改为**带值旗标列一张表**
- 插件工具在桌面里**根本没下发给模型**（建引擎时只并了 MCP 条目）—— 日志的 `tools` 字段逮到的
- TypeScript 在 CJS 目标下把 `import()` 编译成 `require()` → 桌面加载不了 ESM 插件；
  而 vitest 里 `new Function` 的 import 又不成立 → **两条路都留着**，各自在自己那半边是对的
- `mark-electron-cjs` 不认目录导入（`./protocols` → 写成 `./protocols.cjs`）→ 启动即崩；已修 + 加自检
- 主循环的委派进度、CLI 的顶层 await、`rl.question()` 在管道输入下丢行 …… 详见各次提交

## 0.2.0

> 版本号跳到 0.2.0 而不是 0.1.0：`v0.1.0` 标签已经用在换代**之前**那一版上了，
> 而这一版是**引擎换代 + 存储格式变更**（旧数据会自动迁移），按语义化版本该走 minor。


这一版是**引擎换代**：agent 逻辑从"Electron 主进程里的一段代码"搬进一个独立内核
（`engine/`），桌面与命令行成为它的两个**平权宿主**。

### 新增

- **命令行宿主 `ding`**
  - `ding run "任务"`：无头跑一轮（文件类工具齐全，经与桌面同一套审批闸门）
  - `ding sessions [--kind …] [--json] [--export <id>] [--cost [--by session|day|model]]`
  - `ding record <会话 id>` / `ding replay <快照文件>`：录快照 / 重放并与录下来的投影 diff
  - `ding models`：列 provider 与模型，逐条标出上下文数据来自哪、核实于何时
- **独立内核 `engine/`**：`core`（纯逻辑，零 IO）/ `runtime`（编排）/ `ports`（宿主接口）/
  `adapters`（SQLite 存储）。有一条守卫盯着"内核不许 import electron"。
- **事件溯源**：会话状态 = `fold(events)`；新增 `resume`（重放事件流恢复）与
  `replay`（快照重放 diff）。日志即真相，界面是它的投影。
- **SQLite 事件存储**（`node:sqlite`，Node 24 内置）：事务、索引查询、按年龄/条数/容量收口。
  桌面与 CLI 共用同一份实现。
- **模型目录表**（`engine/runtime/budget.ts`）：每条带来源与核实日期，超过 90 天标"可能过期"；
  未登记模型走保守默认并标注 —— 不编数。
- **成本账本**（`engine/core/ledger.ts`）：从事件流现算，数字只来自 provider 上报的 `usage`；
  缺失字段写 `-` 而不是 `0`。
- **快照设施**：`engine/core/snapshot.ts` 把"记录 + 当时的投影"存成 fixture，重放逐轮比内容。
- **审批闸门语义收拢**（`engine/core/gates.ts`）：待办清单与决策记录各只有一处定义。

### 变化

- **产品更名：Dingwork → Ding Harness**（包名 `ding-harness`、appId `com.dingharness.app`）。
  旧版安装的数据目录 `%APPDATA%\Dingwork` 在首次启动时**整体搬**到新目录。
- **桌面跑在新内核上**：`ai:chat` → `createEngine()` → 内核写日志、宿主只上屏。
- **会话事件从 `userData/sessions/*.jsonl` 迁到 `userData/sessions.db`**（SQLite）。
  旧日志在启动时**一次性搬进库**：只读旧、写新、不删旧、幂等（重跑不会重复迁）。
  读接口会等迁移完成 —— 否则老用户升级上来的第一眼是空列表。
- **保留策略换代（一处刻意的语义变化）**：旧版在单个会话超过 4MB 时做**轮转**
  （把文件改名成 `.old`），后果是**那个会话被截断**、恢复不完整。
  现在改成**整会话淘汰**（从最旧的删），容量上限放宽到 64MB。
  代价说清楚：被淘汰的是整个会话，不是一部分。
- **上下文额度按模型上限算**，并**封顶在原来的 2 万 token**。
  往下跟着模型走（上限小的少留，别顶爆）；往上不跟着放大 ——
  历史每轮都要重发，从 2 万涨到 50 万等于单轮成本 ×25，且是静默的。
  想留更多请显式调 `MAX_KEEP_TOKENS`（Phase 9 会接成配置项）。
- 工具注册表统一：内置声明直接来自 `AGENT_TOOLS`（不再手抄），MCP 动态追加，插件为 Phase 8 预留位。

### 修复

- **`DSH_NO_REAL_MODEL` 一直是句空话**：CI 里写着它、注释也承诺"会挡住真调模型"，
  但仓库里**没有任何代码读它**。现在内核真的读：指向本机的地址放行，远程一律拒。
  （代价实测过：跑一条 `accept-tools.mjs` 会真的往输入框填提示词点发送。）
- 上述闸门做好之后发现**它被绕过**：`runTurn` 自己又写了一遍 provider 解析，
  没走 `resolveTurnTarget` → 已收敛成一处，并补了"真的没发请求"的断言。
- 工具注册表重构**漏掉了 `list_files`**（它原来只存在于手抄的那份对象里，不在 `AGENT_TOOLS`）——
  无类型错误、无测试红，只是模型少一个工具。已补回并加守卫。
- `pnpm electron:build` 此前是**红的**，而 typecheck/lint/test 全绿（两套 `include`）。
- 验收脚本里 179 处硬编码的旧项目绝对路径（项目迁到 `C:\DingHarness` 后全部失效）改成相对仓库根。
- `providers.ts` 的 baseURL 改为惰性读环境变量（原来在模块初始化时读一次就定死）。
- 测试抖动：假 provider 的共享计数器跨用例串状态、SQLite 用例的临时目录清理在 Windows 上
  EPERM 判红（都改掉了）。

### 打包链修好：安装包能装、能启动

打出来的安装包先前**启动即崩**（`Cannot find module 'readable-stream/passthrough'`）——
根因是 electron-builder 的 node_modules 收集路径**每个包只保留一份版本**，
不带嵌套副本走（`lazystream` 要 `readable-stream@2` 的子路径，而顶层那份是 v3）。
**开发态看不到它**，CI 也不打包，所以一直没被发现。

修法是 `pnpm package:win` 的两步（缺一不可）：先用 `scripts/stage-app.mjs` 摆一个
**只装生产依赖**的 app 目录，再让 `build.files` 对 node_modules 走**对象形态**
（原样拷、绕开收集器）。判据是现成的 `node scripts/verify-packaged.mjs`（起包、等调试端口）。

### 如实记下的边界

- 仅 Windows 构建；macOS / Linux 未验证。
- `run_command` 与用户同权限运行，**没有沙箱**。
- 只有 OpenAI 兼容一种 provider 通道（协议分层在 Phase 5/6）。
- 模型目录表**只有两条**（今天从 DeepSeek 官方文档核实的）。我们 provider 表里默认用的
  `deepseek-chat` / `deepseek-reasoner` 官方已不再列出，因此如实走"未登记模型"。
- 插件在 v1 **进程内执行**（与宿主同权限）：Worker / 容器隔离列 v2。
- CLI 的 npm bin 与安装脚本已就位（`npm i -g .` 本机可用）；**尚未发布到 npm 公共仓库**。
- 品牌字标仍是上一代的字（换名需要重新出图）。
- 安装包能装能启动，但**装完之后的完整人工验收没做**（只跑了几条跑得动的打包类脚本）。
