# 评测与基准（公开成绩页）

> 口径：**没有跑过的数字不写；跑过的数字带环境、命令与失败分类。**
> 这一页随版本更新；历史轮次在 `bench/archive/rounds.jsonl`（爬山闭环自动追加）。

## 1. 两层评测，分开报

| 层 | 是什么 | 判什么 | 花钱 | 当前数字 |
|---|---|---|---|---|
| **过程回归**（`ding eval`） | 63 条离线用例，脚本化 provider | 事件序列 / 回显文案 / 闸门 / 产物 / 账本 | 不花 | **63/63 通过**（基线锁定，见 §3） |
| **任务基准**（`ding bench`，harness 套） | 7 条任务，真引擎 + 真工具 + 判产物 | 文件内容 + 判分命令退出码 | 不花 | **7/7 通过**（见 §2） |
| **SWE-bench Verified**（`swebench` 套） | 官方集，真模型 | 官方 harness | 花 | **抽样 10 条：7 解 / 2 未解 / 1 环境错误**（见 §5；这是抽样，**不是官方面**） |

⚠️ **这两层不能混成一句话。** `harness` 套的模型回复是脚本化的：它证明
"Ding 的编排、工具、闸门、恢复能走通"，**不证明模型能修真实仓库的 bug**。
任何跨产品的"智能"比较都必须看 SWE-bench 那一栏，而那一栏现在是空的。

## 2. harness 套（7 条）

最近一次实测（本地，**2026-10-18**，随 0.6.0 发布前的七道门一起跑；2026-10-17 那次同样是 7/7）：

```
Node 24.18.0 / win32
harness：7 条（通过 7，失败 0），通过率 100%
  bugfix 1/1 · feature 1/1 · docs 1/1 · refactor 1/1 · long-horizon 1/1 · recovery 2/2
```

同一份代码在 **macOS 26.7.1 / Node 22.14 / x64** 上跑 `eval` 是 63/63（harness 套没在 macOS 上单跑）。

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

## 5. SWE-bench Verified（抽样 10 条，非官方面）

- 适配层：`engine/bench/swebench.ts`（读官方 JSONL）+ `scripts/bench-swebench.ts`（生成官方预测）。
- **判分交给官方 harness**（`swebench==3.0.5` + Docker），本仓不伪造判分。
- 数据集不进仓（会更新）；下载与运行方式见 [`bench/swebench/README.md`](bench/swebench/README.md)。

### 5.1 这一轮的真实数字（2026-10-18）

| 项 | 值 |
|---|---|
| 数据集 | `princeton-nlp/SWE-bench_Verified`（500 条），**抽 10 条**：flask 1 / requests 3 / seaborn 2 / pylint 3 / pytest 1 |
| 模型 | `deepseek-v4.1-flash-1017`（通道 `tokenrhythm`） |
| 判分 | 官方 harness `swebench 3.0.5`，Docker 29.8.2，每实例独立镜像 |
| `run_id` | `ding-pilot10-lf` |
| 结果 | **resolved 7 / 10**；未解决 2（`flask-5014`、`pylint-4604`）；环境错误 1（`pytest-10051`，镜像里 `git clone` 断流） |
| 用量 | 10 条共 **8.29M 输入 / 0.16M 输出** token（每条平均 828k 输入 / 16k 输出，≈33 步） |
| 命令 | `pnpm tsx scripts/bench-swebench.ts --instances sample.jsonl --out pred.jsonl --provider tokenrhythm --model deepseek-v4.1-flash-1017 --yes-spend` → `python -m swebench.harness.run_evaluation --dataset_name sample-dataset.json --predictions_path pred.jsonl --run_id …` |

⚠️ **这个数不能当"SWE-bench 成绩"引用**：10 条是有偏小样本（只挑了 5 个小仓库），
95% 置信区间宽到 ±28 个百分点。它证明的是**链路真的通了**，不是模型的位次。

### 5.2 这一轮修掉的四个测量缺陷（都会让数字变成假的）

1. **补丁把依赖目录收进来**：agent 在仓库里 `pip install -t .testlibs` 之后，
   `git add -A` 把整个依赖树写进 patch（实测一条 **87,278 行**），官方 harness 必然判不过。
   现在收改动时排除 `.testlibs` / `__pycache__` / `*.egg-info` / `.tox` / `node_modules` / `.venv`，
   并给补丁加 3000 行上限（超了不写进预测、单独计数）。
2. **评估脚本被写成了 CRLF**：官方 harness 在 Windows 上用文本模式写 `eval.sh`，
   容器里的 bash 把每行末尾的 `\r` 当成参数的一部分 ——
   于是 `git checkout <sha> test_requests.py\r` 失败、`pytest\r` 找不到命令，
   **每一版补丁都判不过**（第一次跑出来是 0/10，那是这个 bug，不是模型）。
   修法：写 `eval.sh` 时强制 LF（本机打补丁，未改上游）。
3. **用量根本没记**：生成脚本原来 `onEvent` 是空的，跑完不知道花了多少 token ——
   现在按 `step-finish` 累加输入/输出并存出来（上面的"用量"那一行就来自它）。
4. **测试生成的目录进了补丁**：50 条那轮 `sphinx-10435` 的补丁有 **1,276,898 行** ——
   agent 跑了 Sphinx 自己的测试套，`tests/roots` 下每个用例目录长出一棵 `_build` HTML 树，
   `git add -A` 全收进 patch。这一条只能按"超上限"计失败，但原因不是模型。
   排除清单现在也盖住 `_build` / `.doctrees` / `dist` / `htmlcov` / `*.so` 这类生成物，
   并单点化到 `engine/bench/swebench.ts`（有测试守住 `:(exclude)` 前缀）。

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
