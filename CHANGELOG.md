# 变更记录

本文件记**用户可见**的变化，以及每一版"如实记下的边界"。
仓库里每一处"为什么不这么做"的推理写在代码注释里（本项目的口径：注释讲约束与意图，不记流水账）。

## 0.1.0-rc（未发布）

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
- 插件市场、多 agent 协作、CLI 产品化（npm 分发）尚未开始（Phase 7/8/9）。
- 品牌字标仍是上一代的字（换名需要重新出图）。
- 安装包能装能启动，但**装完之后的完整人工验收没做**（只跑了几条跑得动的打包类脚本）。
