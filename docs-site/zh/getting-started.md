# 十分钟跑通

目标：**干净的机器 → 一条命令装好 → 配一个模型 → 跑完第一轮**。

> 发布状态如实说：`@ding/cli` 包已构建并校验，但**尚未发布到 npm**。
> 卡点是 **`@ding` 作用域归属**（属于另一个真实 npm 用户，与引擎包当初同一个病），
> **不是 2FA**；「发不发」也还没拍板（见 `packages/cli/PUBLISHING.md`）。
> 在发布之前，用下面的「源码跑法」，它跑的是同一条代码路径。

## 源码跑法（现在就能用）

```bash
git clone https://github.com/johnGriffith461/DingHarness.git
cd DingHarness
pnpm install
pnpm ding init            # 配 provider / 模型 / 工作目录（会问你要 key）
pnpm ding doctor          # 自检；失败项都写了下一步
pnpm ding run "把 demo 里的 md 整理成一份纪要" --dir ./demo
```

## 装好之后（npm 路线，发布后）

```bash
npm i -g @ding/cli
ding doctor
ding init
ding run "…" --dir ./你的目录
```

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
