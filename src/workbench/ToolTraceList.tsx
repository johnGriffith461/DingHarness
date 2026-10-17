import { useEffect, useState } from "react";
import type { ToolTrace } from "@shared/agentTools";

/**
 * 工具留痕列表（§185 抽出来的共享组件）。
 *
 * ## 为什么抽出来
 *
 * 这段标记原来只长在工作台的步骤里（那时聊天那条路要的是同一件事：被闸门拦下的调用
 * 写着「等你确认」却**没有可点的按钮** —— 一条**无法处置的通知**，§176 已为"子智能体
 * 上交的调用"修过同款问题）。
 *
 * ⚠️ 2026-10-17 更正：**聊天子系统后来整块删掉了**（见 CHANGELOG），所以这个组件现在
 * 只有**一个**调用点（工作台 `TaskView`）。`actionPrefix` 那个口子留着（两个界面的
 * 前缀不同曾是它的理由），但今天只有 `wb-tool-*` 一种在用 —— 这句如实记在这里，
 * 免得下一个人照着"两个界面"去找第二个调用点。
 *
 * 回归哨兵：`scripts/accept/accept-approve.mjs`（`§176` 那条路）。
 */
export function ToolTraceList({
  traces,
  onResolve,
  testIdPrefix = "wb-tools",
  /**
   * 每个 action 的 testid 前缀。
   *
   * 两个界面各用各的（工作台 `wb-tool-allow-*`、聊天 `chat-tool-allow-*`），
   * 免得自动化脚本在两边撞车。
   */
  actionPrefix = "wb-tool",
  /** 列表容器的 testid（配上这一步/这条消息的 id）。 */
  id,
  /**
   * 这段会话的 id（**授权记录要落在它里面**；不给 = 不画"授权他人批"那颗控件）。
   * 工作台那条路给 task 的会话 id、聊天给对话 id —— 与 `onResolve` 那条路同一个来源。
   */
  grantSessionId,
}: {
  traces: ToolTrace[];
  onResolve: (toolCallId: string, approve: boolean) => void;
  testIdPrefix?: string;
  actionPrefix?: string;
  id: string;
  grantSessionId?: string;
}) {
  /**
   * **名册**（"授权他人批"要挑人）。
   *
   * ⚠️ 只在这个列表里**真有待决**时才去读（没有待决就没有授权可谈）——
   * 每一条消息都去问一次主进程是没必要的开销。
   */
  const [members, setMembers] = useState<Array<{ id: string; displayName: string }>>([]);
  const [grantNote, setGrantNote] = useState("");
  const hasPending = traces.some((t) => t.pending === true);
  useEffect(() => {
    if (!hasPending) return;
    const shell = (globalThis as unknown as { shell?: { space?: { state: () => Promise<{ members: Array<{ id: string; displayName: string; isOwner: boolean }> }> } } }).shell;
    let alive = true;
    void shell?.space
      ?.state()
      .then((got) => {
        /* 主人不用列（他自己就能批）—— 列的是"可以授出去的人" */
        if (alive) setMembers((got?.members ?? []).filter((m) => !m.isOwner).map((m) => ({ id: m.id, displayName: m.displayName })));
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [hasPending]);

  /**
   * 已经点下去、还在等的那些调用（2026-10-16 审计 P48）。
   *
   * ⚠️ 这两颗键原来是**裸的** `onClick`：点一下跑一次，连点两下就是**两遍副作用**
   *（`runToolOnce` 是真在主进程干活的：写文件、跑命令）。而"重新生成"那类操作的
   * 反馈要等一次往返，用户等不及就会再点一下 —— 那不是误操作，是界面没给反馈。
   * 现在点下去立刻禁用并改成「执行中…」，等到那条 trace 不再是 `pending` 才复位。
   * （store 侧另有一道同键守卫，见 `store.resolveTool` —— 界面禁用只是第一层。）
   */
  const [busy, setBusy] = useState<Record<string, true>>({});

  /** 那条 trace 不再是 `pending` 了（store 已经落了结果）→ 解除本地的"执行中"。 */
  useEffect(() => {
    setBusy((current) => {
      const stillPending = new Set(traces.filter((t) => t.pending).map((t) => t.toolCallId));
      const next: Record<string, true> = {};
      let changed = false;
      for (const key of Object.keys(current)) {
        if (stillPending.has(key)) next[key] = true;
        else changed = true;
      }
      return changed ? next : current;
    });
  }, [traces]);

  if (traces.length === 0) return null;

  /** 点一下：先登记"执行中"，再交出去（重复点击直接吞掉）。 */
  const decide = (toolCallId: string, approve: boolean): void => {
    if (busy[toolCallId]) return;
    setBusy((current) => ({ ...current, [toolCallId]: true }));
    onResolve(toolCallId, approve);
  };

  return (
    <div className="wb-assistant-tools" data-testid={`${testIdPrefix}-${id}`}>
      {traces.map((t, i) => (
        /*
          被审批闸门拦下（`pending`）的那一条要**给出路**（§144）：
          「允许」= 原样执行「拒绝」= 只留痕。没有这两个按钮，
          闸门就只是"拦下并让你干等着" —— 那是半步。
        */
        <span
          className={`wb-tool-line${t.ok ? "" : " is-bad"}`}
          key={t.toolCallId || `${t.name}-${i}`}
          /*
           * 稳定 testid（§176）：不能靠里面的按钮定位这一行 ——
           * 放行/拒绝之后**按钮就没了**，那样"读那一行的文案"会在操作之后失效。
           */
          data-testid={t.toolCallId ? `wb-tool-line-${t.toolCallId}` : undefined}
        >
          {t.line}
          {/*
            ⚠️ 参数原文**可展开**（补完③，账本 P3 的 `§175.6`）：
            那一行末尾只放得下一句参数摘要（`（写入「…」）`），模型传的**完整参数**
            得能看见 —— 否则"它到底传了什么"只能靠猜，而这正是排错时第一个要看的东西。
            默认收起（不占地方），点开给一段 `JSON.stringify(input, null, 2)`。
            `t.input === undefined` 时不渲染（**不摆一个空的开合**）。
          */}
          {t.input === undefined ? null : (
            <details className="wb-tool-args" data-testid={t.toolCallId ? `wb-tool-args-${t.toolCallId}` : undefined}>
              <summary>参数</summary>
              <pre>{JSON.stringify(t.input, null, 2)}</pre>
            </details>
          )}
          {t.pending ? (
            <span className="wb-tool-actions">
              <button
                className="wb-tool-btn is-primary"
                data-testid={`${actionPrefix}-allow-${t.toolCallId}`}
                data-busy={busy[t.toolCallId] ? "1" : undefined}
                disabled={Boolean(busy[t.toolCallId])}
                onClick={() => decide(t.toolCallId, true)}
              >
                {busy[t.toolCallId] ? "执行中…" : "允许"}
              </button>
              <button
                className="wb-tool-btn"
                data-testid={`${actionPrefix}-deny-${t.toolCallId}`}
                disabled={Boolean(busy[t.toolCallId])}
                onClick={() => decide(t.toolCallId, false)}
              >
                拒绝
              </button>
              {/*
                ⭐ **授权他人批**（C3 3.7b 的流转那一半）：把这条待决的裁决权授给一个成员 ——
                他那边（HTTP `/v1/approvals` 或另一台设备）就能处置它。
                没有成员可授时**不画这颗控件**（不为空名册画一个点了没用的按钮）。
              */}
              {members.length && t.toolCallId ? (
                <select
                  aria-label="授权他人批"
                  data-testid={`${actionPrefix}-grant-${t.toolCallId}`}
                  className="wb-tool-grant"
                  defaultValue=""
                  disabled={Boolean(busy[t.toolCallId])}
                  onChange={(event) => {
                    const target = event.target.value;
                    if (!target) return;
                    const ask = (globalThis as unknown as {
                      shell?: { space?: { authorizeApprover: (i: { sessionId: string; toolCallId: string; target: string }) => Promise<{ ok: boolean; line?: string; error?: string }> } };
                    }).shell?.space?.authorizeApprover;
                    void ask?.({ sessionId: grantSessionId ?? "", toolCallId: t.toolCallId, target })
                      .then((got) => setGrantNote(got?.ok ? (got.line ?? "已授权") : (got?.error ?? "授权失败")))
                      .catch((error: unknown) => setGrantNote(String((error as Error)?.message ?? error)));
                    event.target.value = "";
                  }}
                >
                  <option value="">授权他人批…</option>
                  {members.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.displayName}（{m.id}）
                    </option>
                  ))}
                </select>
              ) : null}
            </span>
          ) : null}
        </span>
      ))}
      {grantNote ? (
        <div className="wb-tool-grant-note" data-testid="wb-tool-grant-note">
          {grantNote}
        </div>
      ) : null}
    </div>
  );
}
