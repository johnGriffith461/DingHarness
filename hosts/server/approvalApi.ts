import type { IncomingMessage, ServerResponse } from "node:http";

import { describeToolResult, rejectedLine } from "../../shared/agentTools";
import {
  approvalRecord,
  approversFor,
  authorizeApprover,
  canDecide,
  grantLine,
  grantRecord,
  GRANT_ALREADY_NOTE,
  pendingFor,
} from "../../engine/core/gates";
import type { ApprovalRecord, LogInput, LogRecord } from "../../engine/core/events";
import type { ApprovalsIndex } from "../../engine/adapters/sqliteApprovals";
import type { RequesterIdentity, ServerOptions } from "./agentServer";
import { canReadSession, spaceOf } from "./spaceApi";

/**
 * **审批的 HTTP 面**（C3 3.7b：多成员审批流转，2026-10-17 补）。
 *
 * ## 它补的是哪一格（如实说）
 *
 * 在这之前，裁决**只长在桌面本机**（`electron/ipc/ai.ts`）：
 * 被拦下的调用、待谁批、批了没有，全都留在会话日志里，而**没有一个远端入口**
 * 能让别人（或者别的设备）去处置它 —— 于是"接管人看到待决、无审批穿透"这条
 * 只有数据与判定层成立（`verify-team.ts` 当时验的就是那一半），
 * 真要点一下批准，得坐在那台机器前。
 *
 * 现在两条路都通了：
 *
 * | 方法 | 干什么 | 谁能做 |
 * |---|---|---|
 * | `GET /v1/approvals?session=` | 看有哪些待决（含当前审批人） | 能读这段会话的人 |
 * | `POST /v1/approvals/:sessionId/:toolCallId` | `{action:"approve"\|"reject"\|"authorize"}` | **当前审批人** |
 *
 * ## 三条口径（与桌面那条路一字不差）
 *
 * 1. **真相是日志**：批准/拒绝都落一条 `approval` 记录（带 `decidedBy`），
 *    授权落一条 `approval-grant` 记录；索引表（`approvals`）跟着投影更新。
 * 2. **批准要把结果一起记**（INV-3）：重放时要能还原成"已保存，当前 N 条"那一行 ——
 *    只记"批过了"的话，重启后那条留痕是个没有内容的空壳。
 * 3. **执行发生在服务端**（这是与桌面唯一的不同，也是必须说清的一格）：
 *    成员点批准之后，工具由**服务端**用它自己的授权目录跑一次
 *    （`buildEngine` 给的那份执行体）。桌面那条路是"在本机跑"，
 *    这里不是 —— 所以服务端能碰的范围就是它启动时被授权的那个目录。
 */

/** 这一族要的注入面（宿主把会话库与执行体交给它）。 */
export type ApprovalCtx = {
  opts: ServerOptions;
  identity: RequesterIdentity;
  /** 审批索引（读；写由会话库的 append 投影 —— 见 `sqliteApprovals.ts` 的说明）。 */
  approvals: ApprovalsIndex | undefined;
  json: (res: ServerResponse, status: number, body: unknown) => void;
  readBody: (req: IncomingMessage) => Promise<Buffer>;
  note: (text: string) => void;
  /** 把一条记录追加进会话日志（宿主给的是同一个 store 端口 —— 单一出口）。 */
  append: (sessionId: string, record: LogInput & { actor?: LogRecord["actor"] }) => Promise<void>;
};

/** 应用户可读的那一份（不含内部实现细节）。 */
type ApprovalView = {
  sessionId: string;
  toolCallId: string;
  name: string;
  approvers: string[];
  state: string;
  decidedBy?: string;
  decidedAt?: number;
  createdAt: number;
  /** 当前这个人能不能处置它（界面据此决定给不给按钮）。 */
  youCanDecide: boolean;
};

const viewOf = (row: ReturnType<ApprovalsIndex["get"]> & object, actorId: string): ApprovalView => ({
  sessionId: row.sessionId,
  toolCallId: row.toolCallId,
  name: row.name,
  approvers: [...row.approvers],
  state: row.state,
  ...(row.decidedBy ? { decidedBy: row.decidedBy } : {}),
  ...(row.decidedAt === undefined ? {} : { decidedAt: row.decidedAt }),
  createdAt: row.createdAt,
  youCanDecide: row.state === "pending" && row.approvers.includes(actorId),
});

/**
 * 处理 `/v1/approvals...`。
 *
 * @returns 处理了就给 true
 */
export async function handleApprovalRoute(path: string, req: IncomingMessage, res: ServerResponse, ctx: ApprovalCtx): Promise<boolean> {
  if (!path.startsWith("/v1/approvals")) return false;
  const { json, note, identity } = ctx;
  if (!ctx.approvals) {
    note("审批索引未接线");
    json(res, 501, { error: "这个服务没有接审批索引（宿主没把会话库交给它）" });
    return true;
  }
  if (!ctx.opts.listSessions || !ctx.opts.loadSession) {
    note("会话库未接线");
    json(res, 501, { error: "这个服务没有接会话库（宿主没给 listSessions/loadSession）" });
    return true;
  }

  /* ── 列表 ─────────────────────────────────────────────── */
  if (path === "/v1/approvals" && req.method === "GET") {
    const url = new URL(req.url ?? "/", "http://localhost");
    const wanted = (url.searchParams.get("session") ?? "").trim();
    const only = url.searchParams.get("state");
    const sessions = await ctx.opts.listSessions();
    const space = ctx.opts.space ? spaceOf(ctx.opts.space) : null;
    const emptySpace = { roster: { owner: identity.id, members: [], codes: [] }, tokens: {}, shared: [], sharedRecipes: [], holders: {}, rooms: {} };
    /* 只看**能读的**那些会话（与服务端其它面的同一条门） */
    const readable = sessions
      .filter((s) => (wanted ? s.sessionId === wanted : true))
      .filter((s) => canReadSession(space ?? emptySpace, identity, s.sessionId, { owner: s.owner ?? "local" }))
      .map((s) => s.sessionId);
    const rows = ctx.approvals.list({
      sessionIds: readable,
      ...(only === "pending" || only === "approved" || only === "rejected" ? { state: only } : {}),
    });
    note(`审批：${rows.length} 条（可读会话 ${readable.length} 段）`);
    json(res, 200, {
      approvals: rows.map((row) => viewOf(row, identity.id)),
      you: { id: identity.id, owner: identity.owner },
    });
    return true;
  }

  /* ── 处置一条 ─────────────────────────────────────────── */
  const match = /^\/v1\/approvals\/([^/]+)\/([^/]+)$/.exec(path);
  if (!match || req.method !== "POST") {
    note(`审批路由不认识：${req.method} ${path}`);
    json(res, 404, { error: `没有这个审批路径：${req.method} ${path}（可用：GET /v1/approvals、POST /v1/approvals/:sessionId/:toolCallId）` });
    return true;
  }
  const sessionId = decodeURIComponent(match[1]!);
  const toolCallId = decodeURIComponent(match[2]!);

  let body: { action?: unknown; target?: unknown };
  try {
    body = JSON.parse((await ctx.readBody(req)).toString("utf8") || "{}") as typeof body;
  } catch {
    note("请求体不是 JSON");
    json(res, 400, { error: "请求体必须是 JSON：{action, target?}" });
    return true;
  }
  const action = String(body.action ?? "");
  if (!["approve", "reject", "authorize"].includes(action)) {
    note(`action 不合法：${action}`);
    json(res, 400, { error: `action 只能是 approve / reject / authorize（收到 ${JSON.stringify(body.action)}）` });
    return true;
  }

  /* 门一：读得到这段会话吗（与服务端其它面同一条墙） */
  const owned = (await ctx.opts.listSessions()).find((s) => s.sessionId === sessionId);
  const space = ctx.opts.space ? spaceOf(ctx.opts.space) : null;
  const emptySpace = { roster: { owner: identity.id, members: [], codes: [] }, tokens: {}, shared: [], sharedRecipes: [], holders: {}, rooms: {} };
  if (!canReadSession(space ?? emptySpace, identity, sessionId, { owner: owned?.owner ?? "local" })) {
    note(`审批：${identity.id} 读不到 ${sessionId}`);
    json(res, 403, { error: `这段会话没有共享给你（归 ${owned?.owner ?? "local"}）` });
    return true;
  }

  /* 门二：这条待决在不在 */
  const row = ctx.approvals.get(sessionId, toolCallId);
  if (!row) {
    note(`审批：没有这条待决 ${toolCallId}`);
    json(res, 404, { error: `这段会话里没有这条待决：${toolCallId}` });
    return true;
  }

  const records = ((await ctx.opts.loadSession(sessionId)).records ?? []) as LogRecord[];
  const currentApprovers = approversFor(records, toolCallId);

  /* ── 授权他人批（C3 3.7b 的流转那一半）────────────────── */
  if (action === "authorize") {
    const target = String(body.target ?? "").trim();
    const got = authorizeApprover({ approvers: currentApprovers, byActorId: identity.id, targetId: target });
    if (!got.ok) {
      note(`授权被拒：${got.code}`);
      json(res, got.code === "invalid-target" ? 400 : 403, { error: got.message });
      return true;
    }
    if (got.added) {
      /* 落一条**授权记录**（不是决策记录 —— 用拒绝表达授权会让重放把它误判成已处置） */
      await ctx.append(sessionId, {
        ...grantRecord({
          toolCallId,
          by: identity.id,
          target,
          approvers: got.approvers,
          line: grantLine({ by: identity.id, target }),
        }),
        actor: { id: identity.id, kind: "user" },
      });
    }
    note(`授权：${identity.id} → ${target}${got.added ? "" : "（已在名单里）"}`);
    json(res, 200, {
      ok: true,
      added: got.added,
      approvers: got.approvers,
      line: got.added ? grantLine({ by: identity.id, target }) : GRANT_ALREADY_NOTE,
    });
    return true;
  }

  /* ── 批准 / 拒绝 ─────────────────────────────────────── */
  const check = canDecide({ approvers: currentApprovers, actorId: identity.id, alreadyDecided: row.state !== "pending" });
  if (!check.ok) {
    note(`裁决被拒：${check.code}`);
    json(res, check.code === "stale" ? 409 : 403, { error: check.message });
    return true;
  }

  const pending = pendingFor(records, toolCallId);
  const name = row.name || pending?.name || "";

  if (action === "reject") {
    const line = rejectedLine(name);
    await ctx.append(sessionId, {
      ...approvalInput({ toolCallId, name, approved: false, line, decidedBy: identity.id, approvers: currentApprovers }),
      actor: { id: identity.id, kind: "user" },
    });
    note(`拒绝：${identity.id} 拒了 ${name}（${sessionId}）`);
    json(res, 200, { ok: true, state: "rejected", line, decidedBy: identity.id });
    return true;
  }

  /*
   * 批准 → **真的执行一次**。
   *
   * ⚠️ 这里不再过闸门（与桌面那条同一个理由）：用户已经批过了，再判一次 `ask`
   * 只会永远拦着。能碰的范围 = 这个服务启动时被授权的目录（`buildEngine` 的 dirs）。
   */
  const input = findToolInput(records, toolCallId);
  if (!ctx.opts.makeEngine) {
    note("审批：宿主没给 makeEngine，执行不了");
    json(res, 501, { error: "这个服务没有接引擎（宿主没给 makeEngine）：决定可以留痕，但执行要在会话所在的那一端做" });
    return true;
  }
  const built = await ctx.opts.makeEngine(ctx.opts.cwd);
  if (!built.executor) {
    built.close();
    note("审批：宿主没给工具执行体");
    json(res, 501, { error: "这个服务没有接工具执行体（宿主没把执行体交出来）：决定可以留痕，但执行要在会话所在的那一端做" });
    return true;
  }
  let result: { ok: boolean; output?: unknown; error?: string };
  try {
    const res2 = await built.executor.run(name, input, { mode: ctx.opts.mode, provider: ctx.opts.provider, ...(ctx.opts.model ? { model: ctx.opts.model } : {}), depth: 0 });
    result = { ok: res2.ok, ...(res2.output === undefined ? {} : { output: res2.output }), ...(res2.error ? { error: res2.error } : {}) };
  } catch (error) {
    /* 执行抛错**也是结果**（INV-3）：照样留痕，别让"点了批准、什么都没发生" */
    result = { ok: false, error: String((error as Error)?.message ?? error) };
  } finally {
    built.close();
  }

  const line = describeToolResult(name, result.ok, result.output, result.error, input);
  await ctx.append(sessionId, {
    ...approvalInput({ toolCallId, name, approved: true, result, line, decidedBy: identity.id, approvers: currentApprovers }),
    actor: { id: identity.id, kind: "user" },
  });
  note(`批准：${identity.id} 批了 ${name}（${sessionId}，执行 ${result.ok ? "成功" : "失败"}）`);
  json(res, 200, { ok: true, state: "approved", line, decidedBy: identity.id, result: { ok: result.ok, ...(result.error ? { error: result.error } : {}) } });
  return true;
}

/**
 * 拼决策记录 —— **形状只在 `gates.approvalRecord` 里算一遍**（批准与拒绝两条分支
 * 各手抄一遍的话，抄漏一个字段不会报错，只会让留痕变成空壳；桌面那条路的注释里
 * 写着同一句话）。
 */
function approvalInput(input: {
  toolCallId: string;
  name: string;
  approved: boolean;
  line: string;
  decidedBy: string;
  approvers: readonly string[];
  result?: { ok: boolean; output?: unknown; error?: string };
}): LogInput {
  return approvalRecord({
    toolCallId: input.toolCallId,
    name: input.name,
    approved: input.approved,
    line: input.line,
    decidedBy: input.decidedBy,
    approvers: input.approvers,
    ...(input.result ? { result: input.result } : {}),
  }) as LogInput;
}

/** 从日志里取那次调用的入参（执行要用它 —— 这正是"日志即真相"的一处收益）。 */
function findToolInput(records: readonly LogRecord[], toolCallId: string): unknown {
  for (const record of records) {
    if (record.type === "tool-call" && (record as { toolCallId?: string }).toolCallId === toolCallId) {
      return (record as { input?: unknown }).input;
    }
  }
  return undefined;
}

export type { ApprovalRecord };
