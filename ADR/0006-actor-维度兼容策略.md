# ADR 0006：事件 actor 维度的兼容策略（C5）

- 日期：2026-10-17
- 状态：**已决定（已落地）**
- Storage：SQLite（`events` 表 + payload JSON）+ `.jsonl`（历史格式）
- Decision owner：Zcode（V5-1 任务 3.4 施工方）
- Reviewed by：**待 Qoder 只读审计 + 人工评审签收**
- Commits：与实现同笔提交（`engine/core/events.ts` + `engine/index.ts` + `engine/adapters/sqliteSchema.ts` v3 + 宿主写入点）
- Open follow-ups：
  · V5-2 任务 2.3（SSE 事件透传 actor）会把 actor 也放上**流**，不只放日志；
  · V5-1 3.7（C3）把 `approval` 记录的 actor 从 `LOCAL_USER` 换成**真实裁决人**；
  · 委派事件的 actor 现在是主循环（子智能体名字只在 payload 的 `agent` 里）——
    3.6 的成员-角色模型落地后再定要不要细化为子智能体自己的 actor。
- 依据（本地代码与实测）：`engine/core/events.ts`（记录形状与 `parseLogLine`）、
  `engine/engineRun.test.ts`（默认标注 / 宿主指定 / 体积预算三条实测）、
  `engine/core/snapshot.test.ts`（actor 不进投影指纹）、
  `engine/adapters/sqliteSchema.test.ts`（v3 两列与 legacy 兜底）。
- 外部参照：12-Factor Agents Factor 12（agent 是无状态 reducer，**事件必须自描述** ——
  actor 是因果元数据的必需件）；M3 调研（事件溯源与 CmRDT 数学同构：actor 是因果元数据的必需件）；
  V5 §3.1 兼容矩阵（旧日志读回 actor="legacy"；新字段不进投影 diff 比较集）。

## 背景

C5 要求**事件带 actor 维度**（谁写下的）。两件必须同时成立：

1. **旧数据零迁移可读**（V5 §1 的"身份向后兼容"不变量：新增字段带默认值）——
   仓里存在大量 actor 维度上线之前写下的日志（`.jsonl` 旧文件、`sessions.db` 老行、
   评测 fixture、快照）。
2. **不许让历史快照集体假红**：`diffSnapshot` 是"换代行为不变"的唯一机器判据，
   它比的是**逐轮投影指纹**。actor 是元数据，若进了指纹，actor 一落地，
   所有存量快照齐刷刷报漂移 —— 那等于把"零漂移"这个门禁弄报废。

## 决定

### 1. 形状：`actor?: { id, kind }` 记在记录里（可选 → 读回必填）

- `LogRecord` 的三个成员（`LoggedEvent` / `TurnRequest` / `ApprovalRecord`）各加
  **可选**的 `actor`。可选是刻意的：旧写入方（测试、fixture、第三方调用）零迁移成本。
- 读路径**唯一收口**在 `parseLogLine` → `normalizeActor`：读回来的每条记录都带着 actor。
  所有读日志的地方用 `actorOf(record)` 取，别各自写 `?? legacy`。

### 2. kind 四值：`user | agent | system | legacy`

前三个来自 V5 §3.2b 的目标 schema 草案。第四个是**实现时加的**，理由是诚实：
actor 维度上线之前的记录，我们**不知道**是谁写的 —— 把它归进 `system`
（"机器写的"）是编一个并不知道的事实，而 C5 的审计恰恰靠这个字段回答"谁做的"。
所以 `legacy` 专门表示"这一条早于 actor 维度"。**草案是草案，实现不为对上草案而编数据。**

### 3. 谁写（标注点只有两处）

| 谁写的 | 标什么 | 在哪标 |
|---|---|---|
| 内核：`request` 记录 | `request.actor ?? LOCAL_USER`（本机用户） | `engine/index.ts` 的 `record()` —— **唯一记录出口** |
| 内核：这一轮里的所有事件 | `MAIN_AGENT` | 同上（同一个出口） |
| 宿主：审批记录（批准/拒绝） | `LOCAL_USER`（3.7 换成真实裁决人） | `electron/ipc/ai.ts` |
| 宿主：宿主级记录（"这一轮起不来"、`resume` 补的终止记录） | `SYSTEM_ACTOR` | `electron/ipc/ai.ts` / `hosts/cli/cmdResume.ts` |

**为什么集中在内核那一个出口**：每个 emit 点各标一次，迟早有新的 emit 点忘了标 ——
"新写入全带"会烂在没人注意的地方。调用方**自己标过的**（`record.actor` 非空）内核尊重它。

### 4. 存储：`events` 加两列（迁移 v3），与 payload **同一口径**

`actor_id TEXT NOT NULL DEFAULT 'legacy'` + `actor_kind TEXT NOT NULL DEFAULT 'legacy'`。

- 两列是给**查询/审计**的（"某人做过什么"不该把每行 JSON 解一遍）；**payload 是真相**。
- 写入时取 `actorOf(record)`（读路径同一个函数）；没有 actor 的记录两列落 `legacy`，
  **payload 里不会被偷偷补字段**（存储是纯落盘，不编数据）。
- v3 之前的行：**补列即完整迁移**（那些行不可能带 actor —— actor 与这两列同一笔提交上线），
  所以不需要从 payload 搬值。
- 回填/回退：actor 是附加元数据。回退 = 新程序不写 actor（读兼容仍在）；
  两列留在库里（**不降级**，见 ADR-005 的闸门）。

### 5. 投影 diff **不含** actor

`turnSignature` 不取 actor（实测：老快照 vs 带 actor 的记录 → diff=0）。
理由见背景第 2 条。这条是**有意的**：元数据不该进"行为漂移"的判据。

### 6. 体积预算（V5 §8）：≤ 40 字节/条

实测三种标准 actor 的 JSON 增量约 36 字节（`{"actor":{"id":"main","kind":"agent"}}`），
测试钉着 40 的上限（`engine/engineRun.test.ts`）—— 超了要么改形状，要么改预算，都得说话。

### 7. 坏 actor 不判坏行

`parseLogLine` 遇到形状不对的 actor（手改过、被截断）**兜底 legacy、保留这一行**：
actor 是元数据，缺了它这条记录讲的事仍然成立；把整行判成坏行是拿元数据惩罚正文。

## 明确不做的

- **不做数据迁移**（不给老记录"补写" actor）：读兼容是 V5 §3.1 明文口径
  （"读回投影为 actor=legacy"），而且"给历史编一个作者"正是这一层要避免的事。
- **不把 actor 放进 `AiStreamEvent`**：流是过程、日志是真相。把 actor 放上流
  （SSE 透传）是 V5-2 任务 2.3 的事，那时它要经 IPC 契约走一遍，不该在这笔里顺手带出去。
- **不用 actor 替代 `ownerActor`**：C1（3.5）的 `ownerActor` 回答"这段会话归谁"，
  与"这一句谁说的"是两件事（V5 §1 的语义契约分离）。

## 后果

- 审计查询有了机器可读的维度：`SELECT … WHERE actor_id = ?`（列）+ 重放时每条记录自描述（payload）。
- 老日志、老快照、老 fixture **一行不用改**：读回 actor=legacy、diff 仍为 0。
- 已知边界（如实记）：**委派事件的 actor 是主循环**（"谁写下了这条记录"），
  子智能体的名字在 payload 的 `agent` 字段里 —— 那是"这条记录说谁"。
  两者是否要合一，等 3.6 的成员模型落地后再定。
