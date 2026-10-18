# 十分钟跑通

目标：**干净的机器 → 一条命令装好 → 配一个模型 → 跑完第一轮**。

> 发布状态：CLI 已以 **`ding-harness`** 发布到 npm（`@ding` 作用域属于另一个
> 真实用户，所以包名不带作用域；**与 2FA 无关**）。也可以走下面的「源码跑法」，
> 它跑的是同一条代码路径。

## 源码跑法（现在就能用）

```bash
git clone https://github.com/johnGriffith461/DingHarness.git
cd DingHarness
pnpm install
pnpm ding init            # 配 provider / 模型 / 工作目录（会问你要 key）
pnpm ding doctor          # 自检；失败项都写了下一步
pnpm ding run "把 demo 里的 md 整理成一份纪要" --dir ./demo
```

## 装好之后（npm 路线）

```bash
npm i -g ding-harness
ding doctor
ding init
ding run "…" --dir ./你的目录
```

**干净机器验过（2026-10-18）**：空 `--cache`、空 `--prefix`，从
`https://registry.npmjs.org` 装 `ding-harness@0.6.0`，装完 `ding --version` 是
`0.6.0`、`ding eval` 是 **63/63**。要自己复验：`node scripts/verify-clean-install.mjs`
（要联网，所以不串进 `pnpm verify`）。

⚠️ **CLI 的 key 是明文**（`~/.dsh/.credentials.yaml` 的 `refs:` 段）：CLI 没有系统钥匙串
集成，`ding init` 会照实说。想减少明文面就用环境变量，或在桌面端填（走系统加密库）。

## 第一轮该看见什么

- 工具栏：模型、档位（全部允许 / 按需确认 / 每步确认）、工作目录；
- 写文件 / 跑命令在「按需确认」下会**停下来等你点**（闸门不是装饰）；
- `ding sessions` 能列出刚才那一轮；`ding sessions --cost` 能看到用量。

## 卡住了看哪里

| 现象 | 先做什么 |
|---|---|
| 连不上 provider | `ding doctor`；确认 key 与 baseURL |
| 写文件被拒 | 工作目录不在授权范围：`--dir <目录>` 或改配置 |
| 想回退 | 桌面：消息上的「回退」；CLI：`ding fork <会话> --at-turn N` |
| 想看清一轮为什么慢 | 桌面「用量与追踪」页，或 `ding sessions --cost --by day` |
