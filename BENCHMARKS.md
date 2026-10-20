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
| 判分 | 官方 harness `swebench 3.0.5`，Docker 29.8.2（WSL2，44GB），`--max_workers 8`，每实例独立镜像 |
| 生成 | `scripts/bench-swebench.ts`，单次自主 rollout，`maxSteps=40`，无重试/无 best-of-N |
| 判分 `run_id` | `ding-final50d`（在 `ding-final50b` 上修掉补丁行尾缺陷后重判，见 §5.2 第 7 条） |
| **结果（分母 50）** | **resolved 31 / 50 = 62.0%**；未解决 11；环境错误 1；空补丁 7 |
| 结果（分母 43 有补丁的） | resolved 31 / 43 = **72.1%** |
| 95% 置信区间 | **±13.4 个百分点**（n=50，正态近似，未做多重比较校正） |

**逐项拆解（这是这一节最该看的部分，不是那个百分比）**：

| 类别 | 条数 | 说明 |
|---|---|---|
| 解出 | **31** | FAIL_TO_PASS 全绿、PASS_TO_PASS 不红 |
| 未解（真·模型失败） | **11** | **11 条全部 `patch_successfully_applied: True`** —— 补丁打上了、测试仍红。这是模型没做对，不是装置坏了 |
| 环境/装置错误 | **1** | `django__django-10880`：**预测文件本身就带 `\r`**（宿主机 `core.autocrlf=true` 把工作树检成 CRLF），容器里 `git apply` 打不上。生成侧已修，但这批预测改不回来 |
| 空补丁·真无改动 | **3** | `seaborn-3069`、`pylint-4604`、`pylint-4970`（模型 14–40 步后没落任何改动） |
| 空补丁·超行数上限 | **2** | `sphinx-10435`（**1,276,898 行**，收了测试生成的 `_build` 树）、`sphinx-10466`（3,567 行） |
| 空补丁·clone 断流 | **1** | `matplotlib-20488` |
| 空补丁·批次崩溃漏跑 | **1** | `pylint-4551`（第一轮 `rmSync` EPERM 带走整轮；已加尽力清理） |

**同一批预测、修缺陷前后对比（最能说明"测量缺陷有多贵"）**：

| 批次 | 是否修 `patch.diff` 的 CRLF | resolved |
|---|---|---|
| `ding-final50b` | **否** | **15**（20 条补丁打不上、19 条记成环境错误） |
| `ding-final50d` | **是** | **31** |

**同一批预测，只因 harness 把一个文件写成 CRLF，就少了 16 条本该通过的结果。**
如果不查这一步，我们会对外报 30%（15/50）而不是 62% —— 那就是一个假数字。

**未解实例清单**（供复核）：`astropy-12907`、`astropy-13033`、`astropy-13453`、
`matplotlib-20826`、`flask-5014`、`requests-1766`、`xarray-3095`、`pytest-10081`、
`sphinx-10323`、`sympy-12096`、`sympy-12419`。

⚠️ **样本量与置信区间**：n=50，95% CI 约 **±13.4 个百分点**。
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

## 8. 过程验收（2026-10-19，真 provider）

口径：同一条命令、同一个模型（`tokenrhythm/deepseek-v4.1-flash-1017`，窗口按 1M 声明）、
同一台机器（Windows 11，Node v24.18.0）。金额**未折算**：这个模型没有可核实的单价，
所以只记 token 与墙钟，不写"约 ¥x"。

- 命令：`ACCEPT_PROVIDER=tokenrhythm ACCEPT_MODEL=deepseek-v4.1-flash-1017 node scripts/accept/accept-harness.mjs --yes-spend`
  - 结果：**通过**；临时仓库里 `src/sum.js` 被改、`test/sum.test.js` 未动；测试退出码 0
  - 墙钟 **8.8s**，token **34,354**
- 命令：`... accept-harness-multistep.mjs --yes-spend`
  - 结果：**通过**；轨迹里有成功的 `todo_write` 与 `finish`，`src/mul.js` / `test/mul.test.js` 被创建，测试退出码 0
  - 墙钟 **13.1s**，token **50,579**
- 命令：`... accept-approval-real.mjs --yes-spend`
  - 批准场景：按需确认下写文件被拦 → 执行体真执行 → 结果回注 → 第二轮继续，**没有重复写同一个文件**
  - 拒绝场景：拒绝后文件**一个字节未变**，模型没有重复被拒绝的写操作
  - token **83,110**（两条合计）；墙钟未单独记录
- 命令：`DSH_ACCEPT_ONLY=accept-firstrun.mjs node scripts/verify-acceptances.mjs`
  - 结果：10/10 通过；首跑落在「选模型」、chip 显示 `strata/deepseek-flash`、预算 `0 / 966k（0%）`、默认身份编码
  - 不调模型、零出网

本轮真调用合计约 **35 万 token**（含两次失败重跑）；预算闸：单任务 ≤¥2、整批 ≤¥8，未超出。

**失败过、并已修的**（保留证据，不粉饰）：

1. 首轮多步任务：模型明确回复"我这边实际可用的工具里没有 `todo_write` 和 `finish`"。
   根因是 CLI 的 `CLI_TOOLS` 暴露面与 `ALWAYS_TOOLS` 都没收录这三个协议工具。
2. 审批场景批准后执行失败："这个路径不在可改范围内"。
   根因是 `resolveWriteTarget` 只认绝对路径与裸文件名，模型给的是 `src/a.txt`。
   已把相对路径按第一个授权目录解析（仍过白名单，`..` 逃逸照样拒绝）。

## 9. 过程验收（2026-10-20，真 provider，CLI 能力补齐）

口径同第 8 节：`tokenrhythm/deepseek-v4.1-flash-1017`、窗口按 1M 声明、Windows 11、
Node v24.18.0。只记 token 与墙钟（这个模型没有可核实的单价，**不写"约 ¥x"**）。

| # | 场景 | 命令要点 | 结果 | 墙钟 | token（入+出） |
|---|---|---|---|---|---|
| 1 | 修失败测试（回归） | `ding run "跑 npm test，把失败的那条修好" --mode 全部允许 --json` | 退出 0；测试 1/1；`verification.action=auto`、exit 0；finish 经一次证据修正后 ok | 31s | 77,844 |
| 2 | 多步任务（回归） | 同上，要求 todo + 两个新文件 + 测试 + finish | 退出 0；3 次 `todo_write`、2 个文件、finish ok；测试 2/2 | 15s | 47,412 |
| 3 | CLI 批准 | 按需确认 + 交互输入 `y` | 退出 0；`notes.md` 内容 `hello`；2 次询问（写文件 / 验证命令）各批准 | 17s | 53,070 |
| 4 | CLI 拒绝 | 按需确认 + 交互输入 `n` | 退出 0；文件**未创建**；模型说明卡点，1 次询问 | 8s | 24,134 |
| 5 | 非 TTY → 6 | 管道 stdin，按需确认 | 退出 **6**；`awaitingApproval.name=write_file`；文件未创建；stderr 给出下一步 | 6s | 11,238 |
| 6 | 接受编辑档 | `--mode 接受编辑` + 3 个文件 + 1 条命令 | 退出 0；**3 次写文件 0 次确认**，命令**恰好 1 次确认**；finish ok | 7s | 24,537 |
| 6b | 接受编辑档 · 保护路径 | `--mode 接受编辑` 改 `.env`，交互输入 `n` | 退出 0；**仍然出现 1 次确认**（保护路径没有自动放行）；`.env` 内容未变 | 7s | 24,598 |
| 7a | stdin | `run_command` 跑 `node -e "process.stdin.pipe(process.stdout)"`，stdin=hello | 退出 0；输出 `hello`；模型自己说明"喂完 EOF 不会挂住" | 10s | 17,649 |
| 7b | 后台任务 | `background=true` + `job_output` 轮询 | 退出 0；两次轮询后 `exitCode=0`、输出 `bg-done`；pid 已退出、日志落在 `<数据目录>/jobs/` | 12s | 35,977 |
| 7c | web_fetch | 读 `https://nodejs.org/api/fs.html`，只依据网页总结 `writeFile` | 首次（默认档）退出 6：模型额外想跑 `run_command`，正确停在待确认；改 `--mode 全部允许` 后退出 0；轨迹 `web_fetch:ok` → `finish:ok`，答案是网页里的真实参数表（Node v26.12.0） | 11s / 14s | 73,854 / 143,094 |

合计约 **53.3 万 token**（含一次因档位正确拦截而重跑的场景 7c）。

**关于"TTY"的如实说明**：这次执行环境没有可用的伪终端（`winpty` 在没有控制台的会话里
直接断言失败），所以场景 3/4/6 用 `DING_CLI_INTERACTIVE=1` 把"stdin 是管道"显式声明为交互，
走的是**同一条审批代码**（`hosts/cli/approval.ts`），不是第二条实现；
`isTTY` 自动判定分支另有单测（`hosts/cli/approval.test.ts`）。

**本轮失败过、并已修的**：

1. 场景 3 第一跑：第二个审批询问时 stdin 已 EOF，审批件没有收到 `end` 回调，
   挂到 120s 看门狗 → 已改成"挂监听时若流已结束，直接按拒绝处理"。
2. 场景 5 第一跑：`--json` 的 stdout 被人类可读表头污染（`JSON.parse` 失败）→
   已把表头与会话提示改走 stderr（`hosts/cli/main.ts`）。

## 10. 多模型协议工具合规性（2026-10-20，真 provider）

口径：编译产物 `dist-cli/hosts/cli/ding.js`，每件任务一个**独立数据目录**与独立工作区，
`--mode allow --steps 12 --json`，单会话预算上限 `$0.5`（超了暂停，不是失败）。
脚本：`npx tsx scripts/verify-model-compliance.ts --yes-spend`（没有 `--yes-spend` 拒跑；
`DING_NO_REAL_MODEL` / `DSH_NO_REAL_MODEL` 任一开着也拒跑）。

**两家可用通道**（本机凭据实测）：

- `deepseek/deepseek-chat`（官方直连）
- `tokenrhythm/deepseek-flash`（中转）

**另外两家 key 在、但通道本身不可用**（不是协议不合规，如实记）：
`qianwen/qwen-plus` 三件任务全部在上游返回「账户余额不足或额度已用完」（0 token 失败）；
`apihub/deepseek-chat` 本机 DNS 解析不到 `api.apihub.top`（`getaddrinfo ENOTFOUND`）。

| provider/model | 任务 | 退出码 | 墙钟 | token（入+出） | 调过的工具 | todo 合规 | ask 合规 | finish / 证据 | 工具失败 | 重复调用 |
|---|---|---|---|---|---|---|---|---|---|---|
| deepseek/deepseek-chat | 修失败测试 | 0 | 17.1s | 34,171+732 | list_files, read_file, run_command, edit_file, finish | 未调用 | 未调用 | done / 1 条证据 | 2 | 4 |
| deepseek/deepseek-chat | 三步任务 | 0 | 8.8s | 63,735+752 | todo_write, list_files, read_file, run_command, finish | 是（3 项） | 未调用 | done / 1 条证据 | 0 | 0 |
| deepseek/deepseek-chat | 信息不足 | 0 | 8.2s | 39,072+797 | list_files, list_dir, ask_user, finish | 未调用 | 是 | blocked / 0 条证据 | 0 | 0 |
| tokenrhythm/deepseek-flash | 修失败测试 | 0 | 21.9s | 52,537+1,958 | list_files, read_file, edit_file, run_command, finish | 未调用 | 未调用 | done / 1 条证据 | 0 | 0 |
| tokenrhythm/deepseek-flash | 三步任务 | 1 | 124.3s | — | todo_write, list_files, read_file, run_command | 是（3 项） | 未调用 | **未调用**（上游 120s 无输出，看门狗中止） | 0 | 0 |
| tokenrhythm/deepseek-flash | 信息不足 | 0 | 19.5s | 41,426+1,731 | list_files, list_dir, run_command, ask_user, finish | 未调用 | 是 | blocked / 1 条证据 | 0 | 0 |

合计 **301,101 token**（5 条有 usage 的成功轮；tokenrhythm 三步任务在上游卡住，没有拿到 usage，不补 0）。

**按结果落地的降级**（不是只记录）：

1. **不调 `finish` 的模型** → 完成提醒上限从 1 次提到 **2 次**，并新增
   `requireFinish`（CLI `ding run` 与桌面 coding 模式置真）：不再只在"改过文件"时提醒，
   "跑了命令但没声明完成"也会被催；两轮后仍没有有效 `finish` 时，
   `outcome.unfinished=true`，桌面步骤上写「未声明完成（这一轮没有调用 finish，不能当作已完成）」，
   CLI 在 stderr 标「未声明完成」并在 `--json` 里带 `unfinished: true`。
2. **不调 `todo_write` 的模型** → 保持已有行为：没有待办就不显示空待办面板；
   本次两家都调用了且参数合法（`todos` 3 项、状态词表正确），未触发额外降级。
3. **`ask_user` 参数不合规** → 两家都通过了同一份 zod schema（`question` 非空、`options` ≤5），
   本次未触发参数修复；参数校验仍在内核侧（`repairToolCall` 与 schema 同源），不新增第二套。
