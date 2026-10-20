# AGENTS.md —— 给 agent 协作者的项目说明书

> 这份文件是给**在仓库里干活的 agent**（Zcode / Claude Code / Codex / …）看的。
> 人类协作者读 [`CONTRIBUTING.md`](CONTRIBUTING.md)；两者冲突时以本文件 + ADR 为准。

## 先读什么（按顺序，别跳）

1. [`README.md`](README.md) —— 它是什么、怎么跑
2. `docs/ADR/`（**本地**，不入库）—— **契约级决定**（事件模型、权限、fork、E2EE）；改这些之前必须读对应 ADR
3. [`BENCHMARKS.md`](BENCHMARKS.md) —— 公开数字的口径（哪些能比、哪些不能）
4. [`SAFETY.md`](SAFETY.md) —— 安全边界（别在报告里把"已知限制"说成"已支持"）

`docs/` **不入库**（`.gitignore`），别往那里放要给别人看的文档。

## 架构地图

| 层 | 目录 | 规则 |
|---|---|---|
| 内核 | `engine/` | **纯逻辑**：不 import electron、不读全局路径。能整包单测 |
| 宿主 | `hosts/`（CLI / server / ACP / MCP）、`electron/`（桌面） | 装配端口、决定数据放哪；**同一能力只装配一份**（`hosts/cli/assembly.ts`） |
| 契约 | `shared/` | 跨进程类型与词表；**shared 不 import engine** |
| 界面 | `src/` | React；所有 IPC 走 `shared/ipc.ts` 的 `ShellBridge`（`preload` 用 `satisfies` 钉住） |
| 适配器 | `engine/adapters/` | SQLite / 插件台账 / 同步等 IO |

**事件溯源是地基**：`applyEvent` 是唯一 reducer，`fold`/`resume`/`splitTurns`/`fork` 都从它派生。
不要为某个界面另造一套状态机 —— 那会让"重启恢复"和"回放"对不上。

## 不可协商的规矩

1. **只读旧写新不删旧**（兼容矩阵见本地 ADR-0010）；删公开面要 ADR + major。
2. **契约冻结**：`packages/api.frozen.json` 加名字要补清单；删/改签名要 ADR。
3. **不留死控件**：`disabled` + "还没/暂未" 会被 `src/deadControls.test.ts` 判红。
   三条出路：实现 / 移除 / 降级成静态文案。
4. **不许编数**：评测/基准/用量数字必须来自真实运行；没有就写"没跑"。
   公开成绩必须带环境、命令、失败分类。
5. **TODO 不当完成**；注释讲**为什么**，不讲"这一行做了什么"。
6. **一个行为一个家**：计量（`engine/core/context.ts`）、错误话术（`shared/errors.ts`）、
   权限判定（`engine/core/policy.ts`）都只许有一份实现。
7. **改缺陷先复现**：先写一条会红的测试，再改到绿。
8. **验收跑编译产物**（`pnpm build` / `pnpm cli:build`），不只跑源码。

## 常用命令

```bash
pnpm typecheck                 # tsc --noEmit
pnpm lint                      # oxlint
pnpm test                      # vitest（含 engine/**、hosts/**、src/**、shared/**）
pnpm eval                      # 63 条过程回归（不花钱）
pnpm bench                     # 7 条任务级基准（判产物）
pnpm bench:hillclimb --label "这一轮只改了什么"
pnpm build                     # 全链（typecheck/lint/test/打包/验收）
```

花真钱/真网络的路径都有闸：`DSH_NO_REAL_MODEL=1`、`--yes-spend`、`OTEL_EXPORTER_OTLP_*` 不配即关闭。
**不要绕过这些闸**。

## 加东西往哪放

| 要加的 | 放哪 | 别忘了 |
|---|---|---|
| 一个新的工具（模型可调） | `engine/runtime/registry.ts` + 执行体（`hosts/cli/tools.ts` 或 `electron/ipc/tools.ts`） | 权限分类（`policy.ts`）、测试、`SAFETY.md`；`shared/agentTools.tools.test.ts` 会查它是否进了 `CLI_TOOLS` 与 `ALWAYS_TOOLS`（上一轮漏过） |
| 一个后台/长任务类工具 | `engine/runtime/tools/jobs.ts` + 两个宿主的执行体 | 进程退出必须清理（`shutdownJobs`）；输出留尾部并标 `truncated` |
| 一个联网工具 | `engine/runtime/tools/webFetchTool.ts` 的安全边界（禁私网、DNS 先判、1 MiB、`[untrusted]` 包裹） | 别绕开 `isBlockedUrl`/`blockedIp`；`SAFETY.md` 要如实写 |
| 一种新事件 | `engine/core/events.ts` 的 `LoggedEvent` + `applyEvent` | 投影、契约冻结测试、旧日志兼容（可选字段 + 默认值） |
| 一条 CLI 命令 | `hosts/cli/cmdXxx.ts` + `ding.ts` 分派 + `help.ts` + `args.ts` 旗标表 | `args.test.ts` 会扫旗标，漏登记就红 |
| 一个 CLI 旗标 | `hosts/cli/args.ts` 的 `BOOLEAN_FLAGS`/`VALUE_FLAGS` + `help.ts` 两处用法（总帮助与 `COMMAND_USAGE`） | 退出码若有新语义，同时改 `hosts/cli/exitCode.ts` 与 README 退出码表 |
| 一个基准任务 | `bench/tasks/<id>/` + `bench/suites/harness.json` | 写清"挡的是哪一种坏"；红的时候要红得对 |
| 一个设置页里的新格子 | `src/workbench/SettingsPages.tsx` 的 general 页挂组件（如 `WorkspaceSettings` / `PermissionRulesTable`） | 判定做成纯函数 + 单测；文案指向的路径必须真的存在（`accept-workspace-settings.mjs` 验"撤销后立刻读不到"） |
| 一个新的"走不通"诊断 | `shared/routeDiagnosis.ts` 的 `diagnoseRoute`（界面与 CLI 共用一份） | 每类都要有**不同的**动作按钮；`src/workbench/errorActions.test.ts` 查三类动作两两不同 |
| 一项新指标 | 从**已有会话日志**推导（`engine/core/firstHour.ts` 这类），不新增事件类型 | 界面与 CLI 必须调同一个函数；推导不出来就写"没有"，不编数 |
| 一条 ADR | `docs/ADR/NNNN-标题.md`（本地，不入库） | 只增不改；状态写"已决定/已落地/被取代" |

## 测试写在哪

- 纯逻辑 → 同目录 `*.test.ts`（vitest 直接吃）
- 桌面 IPC → 不启 Electron 的层用纯函数测；必须真窗口的走 `scripts/accept/`
- 跨宿主一致性 → `engine/eval/hostParity.test.ts`

## 交付前自检

- [ ] `pnpm typecheck` + `pnpm lint` + 相关 `vitest` 全绿
- [ ] 改行为：测试里有一条**会红**的复现；改数字：`BENCHMARKS.md`/CHANGELOG 同步
- [ ] 没有新增 `TODO`、没有把限制写成"已支持"
- [ ] 没有把密钥、真实用户数据、绝对路径写进仓库
- [ ] 一个子任务一个 commit，信息说清"为什么"

## 验收规矩（2026-10-19 主人点名）

**能力/接线的验收必须用真 provider，不许用本地假服务器代替。**

理由是实测出来的：`fetch` 包装在适配层被静默漏传时，假服务器测不出问题
（它只证明我们把自己造的字段塞进了自己造的对象）；换成真 provider 一跑，
`max_tokens` 到了、`reasoning` 没到 —— 立刻暴露。

- 假服务器仍可用于**不涉及真实协议的纯逻辑**（表驱动、解析、状态机）。
- 但凡是"这个字段到底有没有发到上游、上游认不认"这类问题，
  必须打真 provider，并在报告里写清模型、通道、实际 token 与墙钟。
- 真调用要花钱，所以脚本必须有 `--yes-spend` 闸，并受 `DING_NO_REAL_MODEL` 约束。

**装机版也要验**（F-05，2026-10-20）：`accept-installed.mjs` 跑 `release/win-unpacked`
（`pnpm package:win` 的产物），并在 CI 每次 push 都跑。它验的是"用户装完之后磁盘上
那批文件能不能启动"，开发构建通过**不**代表装机版通过 —— 已实测：`typescript` 只在
devDependencies 时，源码一切正常、装机版启动即崩。
