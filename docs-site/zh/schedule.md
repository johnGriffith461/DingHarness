# 定时任务

两种跑法，**共用同一份** `<数据目录>/schedules.json`：

| 谁跑 | 怎么建 | 什么时候会停 |
|---|---|---|
| 桌面 | 定时任务页 / 对话里让 agent 建 | **关窗就停**（调度在渲染层，已知限制） |
| CLI 守护 | `ding schedule add …` | 关掉终端才停 |

## 建任务

```bash
ding schedule add "每天 9 点" --title "早报" --prompt "汇总昨天的日志发我"
ding schedule add "每 15 分钟" --title "巡检" --prompt "检查构建队列"
ding schedule add --repeat daily --at 9:30 --title "早报" --prompt "…"
ding schedule list
ding schedule pause|resume|remove <id>
```

## 常驻执行

```bash
ding schedule run-due            # 跑一次到点的（可以挂系统 cron）
ding schedule run-due --every 1  # 常驻：每分钟看一次
```

- 每跑完一条就**立即落盘**（`afterRun` 更新 `lastRunAt` / `nextRunAt` / `runs`）——
  中途崩了不会把同一条重复跑一遍；
- 失败会记进 `job.runs[].error`，下次仍按计划；
- `Ctrl+C` 是"跑完手上这一轮再停"。

## 中文时间解析：只认明确说法

支持：`每 N 分钟` / `每小时` / `每天 9 点` / `每天 9:30` / `每周四 16 点`。

**不支持**：`明天`、`下周一`、`工作日`、`每月 1 号`。认不出会直接报错，不猜。
`每周` 档是"每 7 天的这个钟点"—— 调度模型里**没有星期几字段**，命令会明确提示这一点。

## 边界

- 会调真模型（花 token）；预算与 provider 用 `--provider/--model` 或配置里的默认值；
- 桌面与 CLI 同时写同一个文件时是"后写覆盖"（单机单用户，与其它 JSON store 一致）；
- 没有分布式锁：同一台机器别同时跑两个 `run-due`。
