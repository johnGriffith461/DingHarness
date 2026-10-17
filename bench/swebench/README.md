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
