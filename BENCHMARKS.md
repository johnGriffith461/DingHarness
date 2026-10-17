# 评测与基准（公开成绩页）

> 口径：**没有跑过的数字不写；跑过的数字带环境、命令与失败分类。**
> 这一页随版本更新；历史轮次在 `bench/archive/rounds.jsonl`（爬山闭环自动追加）。

## 1. 两层评测，分开报

| 层 | 是什么 | 判什么 | 花钱 | 当前数字 |
|---|---|---|---|---|
| **过程回归**（`ding eval`） | 63 条离线用例，脚本化 provider | 事件序列 / 回显文案 / 闸门 / 产物 / 账本 | 不花 | **63/63 通过**（基线锁定，见 §3） |
| **任务基准**（`ding bench`，harness 套） | 7 条任务，真引擎 + 真工具 + 判产物 | 文件内容 + 判分命令退出码 | 不花 | **7/7 通过**（见 §2） |
| **SWE-bench Verified**（`swebench` 套） | 官方集，真模型 | 官方 harness | 花 | **尚未跑**（适配层已就绪，见 §5） |

⚠️ **这两层不能混成一句话。** `harness` 套的模型回复是脚本化的：它证明
"Ding 的编排、工具、闸门、恢复能走通"，**不证明模型能修真实仓库的 bug**。
任何跨产品的"智能"比较都必须看 SWE-bench 那一栏，而那一栏现在是空的。

## 2. harness 套（7 条）

最近一次实测（本地，2026-10-17）：

```
Node 24.18.0 / win32 / Docker 无
harness：7 条（通过 7，失败 0），通过率 100%
  bugfix 1/1 · feature 1/1 · docs 1/1 · refactor 1/1 · long-horizon 1/1 · recovery 2/2
```

| # | 任务 | split | 挡的是哪一种坏 |
|---|---|---|---|
| 1 | `fix-failing-test` | train | 改测试让它变绿 / 声称修好但没跑测试 |
| 2 | `add-name-flag` | train | 只改测试 / 没跑入口脚本就宣布完成 |
| 3 | `chinese-summary` | train | 不读文件就编 / 留着旧产物不覆盖 |
| 4 | `multi-file-rename` | test | 只改定义、不改调用 |
| 5 | `long-horizon-total` | test | 读一半就汇总 / 不跑自检就交付 |
| 6 | `recover-after-error` | train | 一次工具失败就整轮放弃 |
| 7 | `gate-blocks-write` | test | 按需确认档位下写入被自动放行 |

复现：

```bash
pnpm bench
pnpm bench -- --repeat 3     # pass@3 与 pass^3 分开报
pnpm bench -- --json --out bench-report.json
```

## 3. 过程回归（63 条）与基线棘轮

```bash
pnpm eval
pnpm eval --repeat 3         # pass@k 采样；flaky 会单独计数
```

CI 门禁（`pnpm test` 里的 `engine/eval/eval.test.ts`）：

- **零产品失败**、**零装置不可达**；
- 基线（`engine/eval/baseline.json`）记 **63 条 / 100%**，且**逐类只增不减** ——
  "这一类删 5 条、另一类补 5 条"混不过去；
- `--update-baseline` 只能全量跑时用（子集不许覆盖整份基线）。

## 4. 失败分类（跨版本可比）

失败按**封闭枚举**汇总（`engine/eval/failClassifier.ts`），不依赖中文文案：

| 键 | 人话 |
|---|---|
| `event_sequence` | 过程不对（事件序列） |
| `copy_presentation` | 回注缺失（用户可见文案） |
| `tool_silent_failure` | 工具无声失败 |
| `artifact` / `bench_file` | 产物 / 判分文件不符 |
| `gate` | 审批闸门不对 |
| `delegation` | 委派不足 |
| `tool_error_expectation` | 失败原因不对 |
| `tool_listing` | 工具清单不对 |
| `step_budget` | 步数不足 |
| `ledger` | 用量账本缺失 |
| `exception` / `watchdog` | 执行异常 / 超时未收场 |
| `core_check` | 核心判据不成立 |
| `bench_command` | 判分命令未通过 |

装置不可达（本机回环连不上自己的假 provider）**不计入**失败分类，单独计
`environment`；门禁要求它必须是 0。

## 5. SWE-bench（未跑）

- 适配层：`engine/bench/swebench.ts`（读官方 JSONL）+ `scripts/bench-swebench.ts`（生成官方预测）。
- **判分交给官方 harness**，本仓不伪造判分。
- 数据集不进仓（会更新）；下载与运行方式见 [`bench/swebench/README.md`](bench/swebench/README.md)。
- **当前没有可发布的成绩。** 下一版完成官方判分后会在此处补上：
  版本号、模型、`run_id`、`report.json` 摘要、失败分布。

## 6. 爬山闭环（怎么改才算"变好"）

```bash
pnpm bench:hillclimb --label "一句话说清这一轮只改了什么" --repeat 2
```

规则（`scripts/bench-hillclimb.ts`）：

1. **train / test 分开跑**；
2. 只保留"两边都涨"的改动；
3. 显著性门槛：两边各 **+3 个百分点**且两比例 z ≥ 1.96；
4. 任一边显著下跌 → `revert`；
5. 每轮一条记录（`bench/archive/rounds.jsonl`，带 git sha 与改动文件数）；
6. 工作树改动 > 1 个文件时提醒"每轮只改一处"（`--allow-multi` 才继续）。

## 7. 诚实边界

- 任务集 7 条，样本小；百分比的置信区间很宽。爬山的显著性门槛就是对此的补偿。
- `harness` 套是**确定性**的：通过率不随模型变，只随产品代码变。这是优点（防回归），
  也是限制（不能拿来比模型）。
- 评测机与 CI 隔离：harness 套可以进 CI；SWE-bench 预测/判分走独立 workflow 与预算。
