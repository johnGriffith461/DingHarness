# 双宿主能力对照（2026-10-20）

> 桌面（Electron）与 CLI 跑的是**同一个内核**（`engine/`）。这张表只回答一件事：
> **同一个能力，两个宿主各自从哪进、有没有对应路径。**
>
> 每条都指到源码位置；「不一致」条目由 `src/hostParity.test.ts` 卡住上限（≤2 且必须有归属卡）。
> 这张表放在仓库根而不是 `docs/`：`docs/` 是 gitignored 的，而守卫测试要在 CI 里跑。

| 能力 | 桌面 | CLI | 是否一致 | 归属卡 |
|---|---|---|---|---|
| 审批（ask） | `engine/runtime/registry.ts`（ask → `{pending:true}`）+ `electron/ipc/ai.ts` | `engine/runtime/registry.ts` + `hosts/cli/approval.ts`（TTY 就地询问）+ `hosts/cli/exitCode.ts`（退出码 6） | 一致 | — |
| 验证闭环 | `src/workbench/taskRuntime.ts`（`verifyAfterTurn`）+ `engine/runtime/verifyLoop.ts` | `hosts/cli/verify.ts` + `engine/runtime/verifyLoop.ts` | 一致 | — |
| 审阅回滚 | `electron/ipc/review.ts` + `src/workbench/TaskView.tsx` + `engine/runtime/reviewSessions.ts` | `hosts/cli/cmdReview.ts` + `engine/runtime/reviewSessions.ts` | 一致 | — |
| todo | `src/workbench/todoContext.ts` + `src/workbench/TodoPanel.tsx` + `engine/runtime/tools/todoTool.ts` | `engine/runtime/tools/todoTool.ts` + `hosts/cli/tools.ts`（工具留痕与系统提示） | 一致（形态不同：桌面有面板，CLI 看留痕） | — |
| finish | `engine/runtime/finishContract.ts` + `src/workbench/taskRuntime.ts` + `electron/ipc/tools.ts` | `engine/runtime/finishContract.ts` + `hosts/cli/tools.ts` + `hosts/cli/main.ts`（`--json` 带 finished/wroteFiles） | 一致 | — |
| ask_user | `src/workbench/askCard.ts` + `src/workbench/taskRuntime.ts` | `hosts/cli/tools.ts`（ASK_USER 分支）+ `hosts/cli/repl.ts`（REPL 里用下一轮回答；`ding run` 是一次性） | 一致（形态不同） | — |
| Markdown 渲染 | `src/workbench/Markdown.tsx` + `src/workbench/TaskView.tsx` | `hosts/cli/renderRecords.ts`（终端打印原文） | 一致（介质不同） | — |
| 附件 / 资料 | `src/workbench/taskRuntime.ts`（附件内容进请求）+ `src/workbench/Composer.tsx` | `hosts/cli/assembly.ts`（`--dir` 授权 + `read_file`） | 一致（形态不同） | — |
| 计划模式 | `src/workbench/Composer.tsx`（`wb-plan-toggle`）+ `engine/runtime/planMode.ts` | `hosts/cli/main.ts`（`--plan`）+ `hosts/cli/runInputs.ts` + `engine/runtime/planMode.ts` | 一致 | — |
| MCP 连接器 | `electron/ipc/mcpStore.ts` + `electron/ipc/tools.ts` | 无对应路径（CLI 没有连接器配置与传输层） | 不一致 | C-02-MCP |
| 技能 | `electron/ipc/skills.ts` + `engine/runtime/skills.ts` | `hosts/cli/main.ts`（`cliSkillsBlock`）+ `engine/runtime/skills.ts` | 一致 | — |
| 后台任务 | `engine/runtime/tools/jobs.ts` + `electron/ipc/tools.ts` | `engine/runtime/tools/jobs.ts` + `hosts/cli/tools.ts` | 一致 | — |
| 命令 stdin | `engine/runtime/tools/execTool.ts` + `electron/ipc/tools.ts` | `engine/runtime/tools/execTool.ts` + `hosts/cli/tools.ts` | 一致 | — |
| web_fetch | `engine/runtime/tools/webFetchTool.ts` + `electron/ipc/tools.ts` | `engine/runtime/tools/webFetchTool.ts` + `hosts/cli/tools.ts` | 一致 | — |

## 已知不一致（有上限，不许悄悄变多）

### C-02-MCP：CLI 没有连接器（MCP）路径

- 事实：连接器的配置、传输与生命周期在 `electron/ipc/mcpStore.ts`（Electron 主进程）；
  CLI 宿主（`hosts/cli/assembly.ts`）只并内置工具与插件工具，**没有任何 MCP 入口**。
- 为什么本轮不修：连接器需要"配服务器 / 管连接 / 传鉴权"一整套宿主能力，
  与桌面的 IPC 形态绑得很紧；搬到 CLI 要单独设计（配置文件形状、stdio/HTTP 两种传输、凭据）。
  这不是"漏了一行接线"，而是一张新卡。
- 归属卡：`C-02-MCP`（未排期；修之前这张表必须如实写"不一致"）。
- 用户可见影响：`ding run` 用不了 MCP 工具；桌面不受影响。

## 维护规矩

- 加一个新能力：**两列都要写源码位置**；只在一端有路径就写"不一致"，并给归属卡；
- 删/改入口时顺手改这张表 —— `src/hostParity.test.ts` 只卡"不一致条数"与"有没有归属卡"，
  卡不住"描述是否过时"，所以改代码的人要自觉；
- 「一致（形态不同）」是允许的：同一份内核判定、不同的交互介质（面板 vs 终端）不算退化。
