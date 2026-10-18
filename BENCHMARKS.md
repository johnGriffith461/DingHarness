# 评测与基准（公开成绩页）

> 口径：**没有跑过的数字不写；跑过的数字带环境、命令与失败分类。**
> 这一页随版本更新；历史轮次在 `bench/archive/rounds.jsonl`（爬山闭环自动追加）。

## 1. 两层评测，分开报

| 层 | 是什么 | 判什么 | 花钱 | 当前数字 |
|---|---|---|---|---|
| **过程回归**（`ding eval`） | 63 条离线用例，脚本化 provider | 事件序列 / 回显文案 / 闸门 / 产物 / 账本 | 不花 | **63/63 通过**（基线锁定，见 §3） |
| **任务基准**（`ding bench`，harness 套） | 7 条任务，真引擎 + 真工具 + 判产物 | 文件内容 + 判分命令退出码 | 不花 | **7/7 通过**（见 §2） |
| **SWE-bench Verified**（`swebench` 套） | 官方集，真模型 | 官方 harness | 花 | **抽 50 条：外部有效性抽检 + 成本画像**（见 §5；**不是成绩、不参与排名**，理由在 §5.0） |

⚠️ **这几层不能混成一句话。** `harness` 套的模型回复是脚本化的：它证明
"Ding 的编排、工具、闸门、恢复能走通"，**不证明模型能修真实仓库的 bug**。
SWE-bench 那一栏补的是"外部题目 + 外部判分"，但它在 2026 年**已经不能用来排序**
（arXiv 2609.17394：Verified 前三十名里 29 对相邻名次没有一对统计上分得开）。
它的用途有两个，都是排行榜给不了的：**证伪**（"在陌生仓库上跑不通"可以被它打掉）
与**成本画像**（每解一题花多少 token / 多少钱 / 失败在哪 —— 公开数据空白）。

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

## 5. SWE-bench Verified：外部有效性抽检与成本画像（**不是成绩，不参与排名**）

- 适配层：`engine/bench/swebench.ts`（读官方 JSONL）+ `scripts/bench-swebench.ts`（生成官方预测）。
- **判分交给官方 harness**（`swebench==3.0.5` + Docker），本仓不伪造判分。
- 数据集不进仓（会更新）；下载与运行方式见 [`bench/swebench/README.md`](bench/swebench/README.md)。

### 5.0 先说清这一节**不**证明什么

这一节的口径在 2026-10-19 由主人拍板改过一次，原因有三条，缺一条都不能这么写：

1. **该榜对头部模型已失去区分度。** arXiv **2609.17394**（2026 年 9 月）
   《Coding Agents Have Converged: Why the SWE-bench Leaderboard Can No Longer
   Order Its Top Entries》用 254 份提交做的统计：Verified 前两名都解出 **396/500**，
   前三十名里 **29 对相邻名次没有一对**在 α=0.05 上能显著分开（配对 McNemar）。
   结论：小分差不是名次差。本仓**不参与排名**，也不与任何榜单数字比高低。
2. **训练污染无法排除。** 这些仓库与 PR 都是 2023 年以前的公开代码，模型大概率见过。
   所以任何 SWE-bench 分数都**不能作能力声明**，只能当"链路在陌生仓库上没坏"的证据。
3. **脚手架的影响比模型差异还大。** 同一篇论文：同一模型换 scaffold 成绩跨度
   **29.8 个百分点**，而前三十名模型之间只差 **8.8 个点**。
   所以脱离脚手架谈"某模型多少分"没有意义；本仓报的一律是
   **`deepseek-v4.1-flash-1017` + Ding** 这个组合。

**那这一节还剩什么用？** 两条，都是排行榜给不了的：
**外部有效性**（题目和判分都不是我们自己出，无法自我感觉良好）与
**真实成本画像**（每解一题花多少 token、多少钱、失败都失败在哪 —— 这一块公开数据是空白）。

### 5.1 这一轮的真实数字（2026-10-19）

| 项 | 值 |
|---|---|
| 数据集 | `princeton-nlp/SWE-bench_Verified`（500 条），**分层抽 50 条**：django 5 / sympy 5 / sphinx 5 / matplotlib 5 / scikit-learn 5 / astropy 5 / xarray 5 / pytest 4 / pylint 4 / requests 4 / seaborn 2 / flask 1 |
| 模型 | `deepseek-v4.1-flash-1017`（通道 `tokenrhythm`，OpenAI 兼容协议） |
| 判分 | 官方 harness `swebench 3.0.5`，Docker 29.8.2（WSL2），`--max_workers 4`，每实例独立镜像 |
| 生成 | `scripts/bench-swebench.ts`，单次自主 rollout，`maxSteps=40`，无重试/无 best-of-N |
| 判分 `run_id` | `ding-final50c`（在 `ding-final50b` 上修掉补丁行尾缺陷后重判，见 §5.2 第 7 条） |
| 结果 | 见下 |

<!-- RESULT_TABLE -->

⚠️ **样本量与置信区间**：50 条、n=50，95% 置信区间约 **±13 个百分点**。
这个区间宽到**不足以区分「比某个模型强」**——与 §5.0 第 1 条是同一个结论的两种说法。
它的用途是**证伪**（"在陌生仓库上根本跑不通"可以被这个数打掉），不是**排序**。

### 5.2 这一轮修掉的七个测量缺陷（每一个都会把数字变成假的）

> 这一节是本次 E03 最有价值的产出：七个问题**全部落在我们自己的装置或 harness 适配上**，
> 换任何模型、任何仓库都会出现。前六个在前 15 条实例内就全部暴露 ——
> 这也说明"再多跑 450 条"的边际信息量很低。

1. **补丁把依赖目录收进来**：agent 在仓库里 `pip install -t .testlibs` 之后，
   `git add -A` 把整个依赖树写进 patch（实测一条 **87,278 行**），官方 harness 必然判不过。
   现在收改动时排除依赖树与各类缓存，并给补丁加 3000 行上限（超了不写进预测、单独计数）。
2. **评估脚本被写成了 CRLF**：官方 harness 在 Windows 上用文本模式写 `eval.sh`，
   容器里的 bash 把每行末尾的 `\r` 当成参数的一部分 ——
   于是 `git checkout <sha> test_requests.py\r` 失败、`pytest\r` 找不到命令，
   **每一版补丁都判不过**（第一次跑出来是 0/10，那是这个 bug，不是模型）。
   修法：写 `eval.sh` 时强制 LF（本机打补丁，未改上游）。
3. **用量根本没记**：生成脚本原来 `onEvent` 是空的，跑完不知道花了多少 token ——
   现在按 `step-finish` 累加输入/输出并存出来（§5.3 的成本账就来自它）。
4. **测试生成的目录进了补丁**：`sphinx-10435` 的补丁有 **1,276,898 行** ——
   agent 跑了 Sphinx 自己的测试套，`tests/roots` 下每个用例目录长出一棵 `_build` HTML 树，
   `git add -A` 全收进 patch。这一条按"超上限"计失败，但原因不是模型。
   排除清单现在也盖住 `_build` / `.doctrees` / `dist` / `htmlcov` / `*.so` 这类生成物，
   并单点化到 `engine/bench/swebench.ts`（有测试守住 `:(exclude)` 前缀）。
5. **`--max_workers 1`**：为了躲一次管道报错写死成 1，然后一路用下去。
   实测单条 **274 秒 → 76 秒**（4 路），43 条多花 2.5 小时。官方 help 写的是"不超过核数 75%"。
6. **两个生成进程同时烧钱**：重启时旧的 `pnpm → sh → node` 进程树没随外层 shell 退出，
   两份进程跑同一批实例、写同一个文件。现在加了 PID 锁（同一输出文件只允许一个进程写）。
7. **`patch.diff` 也是 CRLF**：与第 2 条同一个文件里的第二处文本模式写盘
   （`patch_file.write_text(...)`）。容器里 `git apply` 每一条都失配，报的却是
   "文件已存在 / different line endings" —— **43 条里 20 条因此假失败**。
   判据：预测 JSON 里的补丁一个 `\r` 都没有，只有 harness 写出来的 `patch.diff` 有。
   修法与第 2 条相同（`write_bytes` + LF 归一）。

### 5.3 真实成本账（本次实测，可核对）

| 项 | 实测 |
|---|---|
| 50 条生成的 token | **39.28M 输入 / 0.73M 输出**，共 **1,613 步**（均值 33 步/条） |
| 缓存命中率 | **约 98%**（每一步都重发历史，所以绝大多数输入按缓存价计） |
| 单价（`/v1/models` 查得，CNY） | 输入 ¥1.00/M、**缓存读 ¥0.02/M**、输出 ¥4.00/M |
| 折算成本 | **约 ¥4.5 / 50 条 ≈ ¥0.09 每实例** |
| 生成墙钟 | 约 4.5 小时（串行为主）＋ 约 1 小时（并发批次） |
| 判分墙钟 | 43 条 **41 分钟**（`--max_workers 4`）；`1` 要 3.3 小时 |

**这张表的用处比分数大**：头部厂商只发布"我们最高分"，没有人发布
"解一道真问题要花多少 token、多少钱"。这一栏是外部无法从别处抄到的。

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
