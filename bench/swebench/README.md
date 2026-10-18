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

### 2. 补丁把依赖目录收进来

agent 为了让测试能跑，常在仓库里 `pip install -t .testlibs ...`，
而收改动用的是 `git add -A` —— 整个依赖树进了 patch（实测一条 **87,278 行**）。
官方 harness 应用不动，必然 unresolved，而这跟"修得对不对"无关。

现在生成脚本用 pathspec 排除 `.testlibs/**`、`__pycache__`、`*.egg-info`、
`.tox`、`node_modules`、`.venv`、`*.pyc`，并给补丁加 **3000 行上限**
（超了不写进预测、单独计数）。判据：正常修复的补丁是**几十到几百行**。

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

500 条全量按这个量级外推是**几十小时 + 数亿输入 token**，先跑 50 条抽样更划算。
