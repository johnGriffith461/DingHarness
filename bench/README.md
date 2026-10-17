# ding-bench（公开基准任务集）

这是 Ding 的**任务级**基准：给一个目标，让 agent 真干活，然后看**产物**对不对。
它与 `engine/eval`（过程判据，内部夹具）是两件事：

| | `ding eval` | `ding bench` |
|---|---|---|
| 判什么 | 过程（事件序列、回显文案、闸门状态） | 结果（文件内容、判分命令退出码） |
| 用谁 | 脚本化 provider | `harness` 套：脚本化；`swebench` 套：真模型 |
| 花钱 | 不花 | `harness` 不花；`swebench` 花 |
| 用途 | 防回归（CI 每次跑） | 公开成绩（发版/爬山时跑） |

## 跑

```bash
pnpm bench:list                  # 列任务（id / split / 类别 / 一句说明）
pnpm bench                       # 跑完整 harness 套
pnpm bench -- --repeat 3         # 每条采样 3 次（同时报 pass@3 与 pass^3）
pnpm bench -- --task fix-failing-test --json
pnpm bench -- --split train      # 只跑训练集
pnpm bench -- --docker           # 判分命令套容器（任务声明了 environment.docker 才生效）
```

退出码：有失败 → 1；只有跳过（环境不满足）→ 0（跳过不计入通过也不计入失败）。

## 任务长什么样

```
bench/tasks/<id>/
  task.json      # 目标、脚本化回复、判分口径、环境锁
  seed/          # 初始工作目录（原样拷进临时目录）
```

`task.json` 的关键字段：

```jsonc
{
  "id": "fix-failing-test",
  "title": "修复失败的单元测试",
  "category": "bugfix",      // bugfix|feature|refactor|docs|long-horizon|recovery|swebench
  "split": "train",          // train 用来改，test 只用来验（爬山纪律）
  "turns": ["…用户说的话…"],
  "replies": [[ { "call": [ … ] }, { "say": "…" } ]],  // 与 turns 等长
  "mode": "全部允许",
  "maxSteps": 8,
  "grader": {
    "files": [
      { "path": "calc.js", "contains": ["return a + b;"], "absent": ["return a - b;"] },
      { "path": "done.txt", "mustExist": false }   // 闸门拦没拦住：文件必须没落盘
    ],
    "commands": [{ "argv": ["node", "test.js"], "exitCode": 0, "stdoutContains": ["ok"] }]
  }
}
```

约定：

- **路径写 `{{dir}}`**（运行时替换成临时工作目录）。任务里不许出现绝对路径。
- **判分只看外部可观察的东西**：文件内容 + 命令退出码/输出。不看模型说了什么。
- **命令不走 shell**（`argv` 数组）：`;` / `&&` 在 Windows/Linux 上语义不同，任务不该依赖它。
- **行尾归一**：文本比较前 CRLF → LF，两个平台判得一样。
- **`mustExist: false`** 用来判"副作用没发生"（例如审批闸门拦住了写入）。
- 新增判据 = 往 `engine/eval/failClassifier.ts` 的 `FAILURE_KINDS` 加键，不许随手新造文案。

## 加一条任务

1. 建 `bench/tasks/<id>/{task.json,seed/…}`；
2. 加到 `bench/suites/harness.json` 的 `tasks` 里；
3. 想清楚"它挡的是哪一种坏"，写进 `description`；
4. 跑 `pnpm bench -- --task <id>`，确认**红的时候红得对**（把种子改坏 → 应该失败）；
5. `split` 默认 `train`；只有用来验证泛化的才放 `test`。

## 容器判分

任务声明 `environment.docker.image` 时，`--docker` 会把**判分命令**放进容器跑
（工作目录挂到 `/work`，`--network none`）。引擎本身仍跑在宿主上——容器只负责
"跑测试命令"，不是安全沙箱。

## 诚实边界（重要）

- `harness` 套的模型回复是**脚本化的**：它测的是 Ding 的编排、工具、闸门、恢复，
  **不测模型智能**。7/7 不等于"能修真实仓库的 bug"。
- `swebench` 套才和公开榜对表，但**判分不在本仓**（见 [`swebench/README.md`](swebench/README.md)）。
  本仓只生成官方格式的预测文件；成绩必须来自官方 harness。
- 两套的数字**不混表**：`BenchReport.suite` 分开，`BENCHMARKS.md` 也分开写。
- 任务集还很年轻（7 条）。样本小，通过率的置信区间很宽；爬山脚本的显著性门槛
  就是为此设的（两边都涨 + z ≥ 1.96 + 至少 3 个百分点）。
