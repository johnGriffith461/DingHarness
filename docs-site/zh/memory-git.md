# 记忆的 Git 工作树（Git-as-memory）

记忆默认在 `<数据目录>/memory.json`：能读写，但看不见历史、不能 diff、不能多机合并。
把它镜像到一个 Git 仓库之后就有了 —— 而且**一条记忆一个文件**，冲突只落在那一条上。

## 用法

```bash
# 首次：把现有记忆镜像出去（目录不存在会自动 git init）
ding memory export --git ~/ding-memory

# 之后：改了记忆就再同步一次；没变化不会造空提交
ding memory export --git ~/ding-memory
ding memory export --git ~/ding-memory --push     # 配好 remote 之后

# 另一台机器：拉回来并合并
ding memory import --git ~/ding-memory --pull
```

定时同步（常驻或系统 cron）：

```bash
ding memory export --git ~/ding-memory --push
ding memory import --git ~/ding-memory --pull
```

## 仓库长什么样

```
entries/
  <记忆 id>.md      # frontmatter + 正文
```

```markdown
---
id: m-xxx
createdAt: 2026-10-17T00:00:00.000Z
source: manual
domain: private
owner: local
---

每周五发周报
```

`git log -- entries/` 就是记忆的变更史；`git diff` 能看出改了哪句话。

## 合并口径（如实）

- **同 id 以 Git 侧为准**（文件是用户可以手工编辑的那一面）；
- **不同 id 都保留** —— 不静默丢任何一条；
- 没有做自动双向 watch：导出/导入是一次命令一次同步，靠 cron/定时任务串起来；  
- 没有做三方合并：同一文件两边同时改，仍由 git 的冲突流程处理（文件级，不会毁整份 JSON）。

## 边界

- Git 是**镜像**，不是第二真相：真相仍是 `memory.json`，删仓库不会丢记忆；
- `push` 需要先配 remote；没配会明确报错，不假装成功；
- 记忆长度上限（200 字/条、100 条）不变 —— Git 承载的是同一份数据，不是放宽理由。
