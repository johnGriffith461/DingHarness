# SWE-bench 适配（V6-1a）

## 结论先说

- 本仓**生成预测**（官方格式），**不判分**。
- 成绩必须来自 **官方 harness**（Docker 环境按仓库/版本起）。理由：自己写一套"差不多"的
  判分，得到的数字不能与公开榜对表，那就失去了"公开基准"的意义。
- 到目前为止，**本仓没有发布过 SWE-bench 成绩**。没有的数字不写。

## 拿到数据集

SWE-bench Verified（500 条，官方推荐用于模型评测）：

```bash
# 方式一：HuggingFace datasets（需要登录与接受条款）
python - <<'PY'
from datasets import load_dataset
ds = load_dataset("princeton-nlp/SWE-bench_Verified", split="test")
ds.to_json("verified.jsonl", orient="records", lines=True)
PY

# 方式二：官方仓库的取数脚本
git clone https://github.com/princeton-nlp/SWE-bench.git
cd SWE-bench && python -m swebench.collect.build_dataset --dataset_name princeton-nlp/SWE-bench_Verified
```

数据**不进本仓**：集合会更新，收一份快照等于让所有人跑旧集还以为跑的是新的。
请把你下载到的文件路径传给 `--instances`。

## 生成预测

```bash
# 先看计划（不花钱；不给 --yes-spend 会退出 2）
pnpm tsx scripts/bench-swebench.ts \
  --instances verified.jsonl \
  --out predictions.jsonl \
  --limit 1

# 确认后真跑（会调用真模型、产生费用）
pnpm tsx scripts/bench-swebench.ts \
  --instances verified.jsonl \
  --out predictions.jsonl \
  --provider deepseek --model deepseek-chat \
  --limit 1 --yes-spend
```

脚本对每条实例：

1. `git clone` 仓库并 checkout `base_commit`（每条都 `reset --hard` + `clean -fd`）；
2. 让 Ding 在克隆目录里跑一轮（`mode: 全部允许`，工具全开）；
3. `git add -A && git diff --cached --binary` 收成补丁；
4. 写一行 `{"instance_id","model_name_or_path","model_patch"}`。

`FAIL_TO_PASS` / `PASS_TO_PASS` / `test_patch` 原样保留在任务来源里，但**不在预测阶段使用**。

## 判分（交给官方）

```bash
pip install swebench
python -m swebench.harness.run_evaluation \
  --predictions_path predictions.jsonl \
  --swe_bench_tasks princeton-nlp/SWE-bench_Verified \
  --run_id ding-v6 \
  --max_workers 4
```

官方 harness 会用每个仓库对应版本的 Docker 镜像，应用 `test_patch` 与你的
`model_patch`，跑 `FAIL_TO_PASS` + `PASS_TO_PASS`。它输出的 `report.json`
才是能写进 `BENCHMARKS.md` 的数字。

## 安全与成本

- **没有沙箱**：agent 在克隆目录里跑 `run_command`（与 `ding` 同权限）。
  只在你自己信任的机器/容器里跑；见 `SAFETY.md`。
- **会花钱**：500 条 Verified 是一大笔。先用 `--limit 1` 打通，再按预算分批。
- 预测脚本**不进常规 CI**（耗时/花费），只在独立的发版 workflow 里手动触发。

## 真跑一遍踩到的坑（2026-10-18，Windows + Docker Desktop）

这一节是**实测记录**，不是理论风险 —— 每一条都让数字变成假的，且都不容易第一眼看出。

### 1. 评估脚本被写成 CRLF（最隐蔽，直接让每版补丁判不过）

官方 harness 在 Windows 上用 `Path.write_text(...)` 写容器里的 `/eval.sh`，
默认是**文本模式 → CRLF**。容器里的 bash 于是把行尾的 `\r` 当成参数的一部分：

```
+ git checkout 22623bd8... test_requests.py?      ← 实际是 test_requests.py\r
error: pathspec 'test_requests.py?' did not match any file(s) known to git
+ pytest -rA test_requests.py?                     ← /eval.sh: line 36: pytest: command not found
```

表现是 **resolved 0 / submitted 10**，看起来像"模型一条都没修对"。
第一次跑就是这样，差点把 0% 当成成绩写进文档。

**本机的做法**：改 `swebench/harness/run_evaluation.py` 里那一行，显式写 LF：

```python
_eval_lf = test_spec.eval_script.replace("\r\n", "\n").replace("\r", "\n")
eval_file.write_bytes(_eval_lf.encode("utf-8"))
```

（这是**本机对上游打的补丁**，不在本仓；重装 harness 会丢，要重打。）
判据很简单：`file logs/.../eval.sh` 不能出现 `CRLF`。

### 2. 补丁把依赖目录收进来（以及测试生成的 `_build` 树）

agent 为了让测试能跑，常在仓库里 `pip install -t .testlibs ...`，
而收改动用的是 `git add -A` —— 整个依赖树进了 patch（实测一条 **87,278 行**）。
官方 harness 应用不动，必然 unresolved，而这跟"修得对不对"无关。

50 条那轮又见到更离谱的一种：`sphinx-10435` 的补丁 **1,276,898 行** —— agent 跑了
Sphinx 自己的测试套，`tests/roots` 下每个用例目录都长出一棵 `_build` HTML 树，
`git add -A` 全收了进去。这条只能按"超上限"计失败，但失败原因**不是模型**。

现在生成脚本用 pathspec 排除依赖树、各种 `__pycache__` / `.pytest_cache` / `*.egg-info`、
`.tox` / `.nox` / `node_modules` / `.venv`，以及**跑一次测试就长出来**的目录
（`_build`、`.doctrees`、`dist`、`htmlcov`、`*.pyc` / `*.so` / `*.whl`），
并给补丁加 **3000 行上限**（超了不写进预测、单独计数）。清单收在
`engine/bench/swebench.ts` 的 `SWEBENCH_PATCH_EXCLUDES`，有测试钉住
"每条都必须带 `:(exclude)`"——裸路径在 `git diff` 里是**包含**过滤，会把补丁收成空。
判据：正常修复的补丁是**几十到几百行**。

### 3. Docker Desktop 管道中断

`--max_workers 2` 时镜像构建阶段偶发
`(109, 'GetOverlappedResult', '管道已结束。')`，而且 Docker Desktop 会**整个退出**
（之后所有实例报 `Error while fetching server API version`）。
用 `--max_workers 1` 稳定；崩了就先确认 `docker info` 能通，再续跑
（已建好的镜像会复用，`cache_level` 默认就够）。

### 4. 临时目录清理失败会中断整轮

Windows 上刚跑完的仓库目录里可能还有句柄，`rmSync` 抛 EPERM。
第一版没兜住，跑到第 9 条整体退出、前 8 条白跑。现在清理是尽力而为（3 次重试）。

### 5. 耗时与花费的真实量级（单条）

| 项 | 实测 |
|---|---|
| 模型轮次 | 15–40 步 |
| 输入 token | 约 30 万–140 万（**每步都重发历史**，所以随步数近平方增长） |
| 输出 token | 约 0.7 万–3 万 |
| 单条墙钟（生成） | 2–5 分钟（含 clone + checkout） |
| 单条墙钟（判分） | 1–3 分钟（首次要建镜像 2–3 分钟；之后复用） |
| 磁盘 | 每个 eval 镜像 1–3 GB |
| 单价（2026-10-19 查 `/v1/models`） | 输入 ¥1.00/M、缓存读 ¥0.02/M、输出 ¥4.00/M（CNY） |
| 单条花费（实测 token × 上述单价） | 约 ¥0.05–0.2（绝大部分输入命中缓存，输出才是大头） |

500 条实测口径：**80 个 repo@version**，每个环境镜像 3.9–5.2 GB —— 一次全建约 **340 GB**，
所以判分要**按仓库分批**（每批判完删该批镜像），见 `batch-grade.mjs` 的用法。

500 条全量按这个量级外推是**几十小时 + 数亿输入 token**，先跑 50 条抽样更划算。

### 6. 别在建模/判分时跑别的重活（2026-10-18 实测）

Docker 镜像构建 + 模型生成 + 本地全量测试三者同时跑，这台机器上出现过两种坏结果：

1. **Docker Desktop 直接起不来**（报 `Docker Desktop is unable to start`）。
   恢复：杀掉 `Docker Desktop` / `com.docker.backend` / `com.docker.build` 三个进程，
   执行 `wsl --shutdown`，再启动 Docker Desktop（约 1 分钟起来）；
2. **本地全量测试集体假红**：SQLite / DOCX / 同步那批用例平时 1–2 秒，
   负载高时跑到 6–14 秒并超时。判据是**单独跑同一条文件就绿** —— 那是环境，不是产品坏了。

所以：判分与生成**串行**跑；这期间不要跑 `pnpm test`。
判分前的镜像构建按仓库/版本合并（50 条实例实测需要 **11 个**环境镜像）。

### 8. `--max_workers 1` 是最贵的一个错误（2026-10-19）

第一版为了躲"管道中断"写成 `--max_workers 1`，然后一路用下去。实测代价：

| 配置 | 单条墙钟 | 43 条 |
|---|---|---|
| `--max_workers 1` | **274 秒** | 约 3.3 小时 |
| `--max_workers 4` | **76 秒** | 约 55 分钟 |

这个参数同时管三件事：环境镜像构建、实例镜像构建、实例评测 —— 全都并行。
官方 help 写的是"不超过核数的 75%"（这台 12 核 → 9）。
之前那次"开 2 就崩"是**同时还在跑生成 + 全量测试 + 建镜像**，不是并发的锅。

稳妥做法：先给 WSL 足够内存（`.wslconfig` 里 `memory=44GB`，
默认只给一半 = 31GB，4 个容器勉强、6 个就 OOM），再上 4 路；
4 路稳了再往上加。判分期间同样不要跑别的重活。

⚠️ **重启 Docker 后必须检查凭据助手**：WSL 重启会让 Docker 重新注册 `credsStore: desktop`，
而宿主的 `PATH` 里如果没有 `%LOCALAPPDATA%\Programs\DockerDesktop\resources\bin`，
每一条实例都会在第一步失败，报
`docker-credential-desktop not installed or not available in PATH` ——
**看起来像 40 条模型全错，实际是环境**。这条已经踩过一次，判分前务必先跑
`which docker-credential-desktop`。

### 9. `patch.diff` 也是 CRLF（2026-10-19，第二次踩同族的坑）

第 2 条修的是 `eval.sh` 的行尾；**同一个文件里还有第二处文本模式写盘**：

```python
patch_file.write_text(pred[KEY_PREDICTION] or "")   # Windows → CRLF
```

于是容器里 `git apply` 每一条都失配，报的却是**很像模型写错**的那几句：

```
The next patch would create the file _check_msg.py, which already exists!
(Stripping trailing CRs from patch; use --binary to disable.)
Hunk #1 FAILED at 1 (different line endings).
```

43 条里 **20 条**这么"失败"了。判据很干净：**预测 JSON 里的补丁一个 `\r` 都没有**，
只有 harness 写出来的 `patch.diff` 有（`cat -A` 看是 `^M$`）—— 那是运输过程弄坏的，不是模型写的。

修法与 `eval.sh` 完全相同：`write_bytes(...replace("\r\n","\n").encode("utf-8"))`。
两个补丁都在 `patch_harness.py` 里，可重复执行；**重装 harness 会丢，要重打**，
打完用 `file logs/.../patch.diff` 或 `cat -A | head -1` 验一下有没有 `^M`。

⚠️ 顺带一条：宿主的 git 全局配置若是 `core.autocrlf=true`，工作树会被检出成 CRLF，
agent 读到的就是 CRLF。容器里是 LF —— 所以生成侧现在显式
`git -c core.autocrlf=false -c core.eol=lf`，让本地工作树和容器一致。

### 10. 怎么把 500 条从"几十小时"压下来（2026-10-19）

串行 500 条的实测外推是 **约 45 小时**（5.5 分钟/条）。两处杠杆，都是真改动：

1. **并行实例**：`--concurrency 6`。每条实例的仓库、临时 store、引擎实例彼此独立，
   并发安全；唯一上限是通道速率与机器内存。
2. **只检出 base commit，不拉全史**：`git clone --filter=blob:none --no-checkout`
   + `git fetch origin <base_commit>` + `git checkout <sha>`。
   实测 django：**16 秒 / .git 83 MB**（整仓克隆要几分钟、几百 MB）。
   保留 commit 与 tag（`setuptools_scm` 这类构建脚本要靠 `git describe` 取版本），
   只按需下载这棵树要用的 blob。

配套：`--resume` 跳过输出文件里已有非空补丁的实例（空补丁会重跑），
命中余额/鉴权/429 时整轮立即停（不会一条条空烧重试），已产出的预测保留可续跑。

命令：

```bash
pnpm tsx scripts/bench-swebench.ts \
  --instances verified.jsonl --out predictions.jsonl \
  --provider tokenrhythm --model deepseek-v4.1-flash-1017 \
  --concurrency 6 --resume --yes-spend
```
