/*
 * 2026-10-21：`strata`（本机假服务）已从**出厂 provider 表**移除 —— 出厂只剩 DeepSeek。
 * 它只在 `DING_ACCEPT_PROVIDERS=1` 时注册；这个脚本是验收/评测工具，自己打开。
 */
process.env.DING_ACCEPT_PROVIDERS ??= "1";

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";

import { createSqliteSessionStore } from "../engine/adapters/sqliteStore";
import { createSpaceStore } from "../engine/adapters/spaceStore";
import { createApprovalsIndex } from "../engine/adapters/sqliteApprovals";
import { taskSessionId } from "../engine/core/events";
import { approversOf, authorizeApprover, canDecide } from "../engine/core/gates";
import { buildEngine } from "../hosts/cli/assembly";
import { startAgentServer } from "../hosts/server/agentServer";

/**
 * **U8 验收 · 团队可用**（V5-3 收官）：真起服务、真跑引擎、真落盘。
 *
 * 与 `hosts/server/serverSpace.test.ts` 的分工：那边用假引擎验**协议与安全口径**
 * （毫秒级，不要 key）；这一份验的是**接上真实内核之后承诺还成立** ——
 * 引擎、SQLite、空间账本、工具闸门全是真的，只有"模型"那一段换成回环上的假端点
 * （零出网、零花费）。
 *
 * | 用例 | 承诺 | 判据 |
 * |---|---|---|
 * | E2E-1 | 邀请与只读（U8-1） | 配对码入团、默认 viewer、只看得见自己的、写别人的 403 |
 * | E2E-2 | 共享打开（U8-2） | 成员读到的记录与主人、与**盘上原文**逐字相同（重放 diff=0） |
 * | E2E-3 | 接管与审批（U8-3） | 接管后记录**真落进**会话（归属不换主）；viewer 的写工具当场拒；admin 的写工具待批且**归主人批** |
 * | E2E-4 | 授权他人批 | 主人把自己的裁决权授给成员（`authorizeApprover`，用真凭据跑） |
 * | E2E-5 | 双端接管（fencing） | 后接管的人写得进去，被换下来的写不进去 |
 * | E2E-6 | 成本分摊 | 账本按成员汇总（主人/alice/bob 各一行）；viewer 查不了 |
 * | E2E-7 | 撤权即时生效（U8-5） | 移除成员 → 他的口令**下一个请求**就 401 |
 * | E2E-8 | 多渠道触发 | 一条渠道消息 → 事件入流 → 回执（done.reply）出得去 |
 *
 * ⚠️ 跑法：`pnpm verify:team`（或 `tsx scripts/verify-team.ts`）。退出码非零 = 有断言红。
 */

const bad: string[] = [];
const ok = (cond: boolean, what: string): void => {
  if (cond) {
    console.log(`  ✓ ${what}`);
    return;
  }
  bad.push(what);
  console.error(`  ✗ ${what}`);
};

/** 一段会话里按条件找记录（真记录 = `loadSession` / `/records` 拿到的那一份）。 */
type Rec = { type?: string; actor?: { id?: string; kind?: string }; toolName?: string; output?: unknown; error?: string };
const findLast = (records: readonly unknown[], pred: (r: Rec) => boolean): Rec | undefined =>
  [...(records as Rec[])].reverse().find(pred);

/* ────────────────────── 假模型端点（零出网）────────────────────── */

/** 「写个文件」= 让模型调 `write_file` 的暗号（判据只看请求体自己 —— 无状态，重跑不会串）。 */
const WRITE_MARK = "写个文件";
/** 待批/被拒的写操作要落在这个文件上（真写成 = 闸门漏了）。 */
const probePath = (dir: string) => path.join(dir, "verify-team-probe.txt");

const CHUNK = { id: "verify-1", object: "chat.completion.chunk", created: 0, model: "deepseek-flash" };
const textFrame = (t: string) => ({ ...CHUNK, choices: [{ index: 0, delta: { content: t }, finish_reason: null }] });
const finishFrame = (reason: string) => ({ ...CHUNK, choices: [{ index: 0, delta: {}, finish_reason: reason }] });
const toolFrame = (args: string) => ({
  ...CHUNK,
  choices: [
    {
      index: 0,
      delta: { tool_calls: [{ index: 0, id: "call_verify_1", type: "function", function: { name: "write_file", arguments: args } }] },
      finish_reason: null,
    },
  ],
});
const usageFrame = (p: number, c: number) => ({ ...CHUNK, choices: [], usage: { prompt_tokens: p, completion_tokens: c, total_tokens: p + c } });

/**
 * 起一个 OpenAI 兼容的假端点。
 *
 * 帧形状与 `engine/eval/fakeProvider.ts` 同一套（那一份是评测用的正主）——
 * 手写一份是因为这一条要的判据是**按消息内容**决定"回话还是调工具"，
 * 而不是"脚本第几条"。
 */
function startFakeModel(dir: string): Promise<{ url: string; close: () => Promise<void> }> {
  const server: Server = createServer((req, res) => {
    let raw = "";
    req.on("data", (d) => (raw += String(d)));
    req.on("end", () => {
      let messages: Array<{ role?: string; content?: unknown }> = [];
      try {
        messages = (JSON.parse(raw) as { messages?: typeof messages }).messages ?? [];
      } catch {
        /* 请求体不合法也照吐 —— 这一层测的不是它 */
      }
      /* 有工具结果 = 同一步之后的续跑：回一句收尾话（否则会无限调工具） */
      const hasToolResult = messages.some((m) => m.role === "tool");
      const lastUser = [...messages].reverse().find((m) => m.role === "user");
      const text = typeof lastUser?.content === "string" ? lastUser.content : "";
      const call = !hasToolResult && text.includes(WRITE_MARK);

      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      if (call) {
        res.write(`data: ${JSON.stringify(toolFrame(JSON.stringify({ path: probePath(dir), content: "只有批准之后才该有这一行" })))}\n\n`);
        res.write(`data: ${JSON.stringify(finishFrame("tool_calls"))}\n\n`);
      } else {
        res.write(`data: ${JSON.stringify(textFrame(hasToolResult ? "明白了" : "收到"))}\n\n`);
        res.write(`data: ${JSON.stringify(finishFrame("stop"))}\n\n`);
      }
      res.write(`data: ${JSON.stringify(usageFrame(Math.max(1, Math.round(raw.length / 4)), 2))}\n\n`);
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      resolve({ url: `http://127.0.0.1:${port}/v1`, close: () => new Promise((r) => server.close(() => r())) });
    });
  });
}

/* ────────────────────── HTTP 小工具 ────────────────────── */

type Frame = { event: string; data: Record<string, unknown> };

/** 发一条 JSON 请求。 */
async function api(
  port: number,
  method: string,
  p: string,
  body?: unknown,
  token?: string,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`http://127.0.0.1:${port}${p}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  try {
    return { status: res.status, json: (JSON.parse(text) as Record<string, unknown>) ?? {} };
  } catch {
    return { status: res.status, json: { raw: text } };
  }
}

/** 收一整段 SSE，拆成帧。 */
async function sse(port: number, p: string, body: unknown, token: string): Promise<Frame[]> {
  const res = await fetch(`http://127.0.0.1:${port}${p}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return text
    .split("\n\n")
    .map((block): Frame | null => {
      const name = /^event: (.+)$/m.exec(block)?.[1] ?? "";
      if (!name) return null;
      const data = /^data: (.+)$/m.exec(block)?.[1] ?? "";
      try {
        return { event: name, data: JSON.parse(data) as Record<string, unknown> };
      } catch {
        return { event: name, data: { raw: data } };
      }
    })
    .filter((x): x is Frame => x !== null);
}

/** 跑一轮并把它是否跑通 + 出错原因一起带回来（失败时那句原因要能直接看见）。 */
async function turn(
  port: number,
  body: Record<string, unknown>,
  token: string,
): Promise<{ ok: boolean; why: string; frames: Frame[] }> {
  const frames = await sse(port, "/v1/run", body, token);
  const done = frames.find((f) => f.event === "done")?.data ?? {};
  return {
    ok: done.ok === true,
    why: String(done.error ?? done.reply ?? "").slice(0, 200),
    frames,
  };
}

/* ────────────────────── 开跑 ────────────────────── */

const dataDir = mkdtempSync(path.join(os.tmpdir(), "dh-verify-team-"));
const fake = await startFakeModel(dataDir);
/* strata 这一家读这两个环境变量（`engine/runtime/providers.ts` 的 baseURLEnv / keyRef） */
process.env.STRATA_BASE_URL = fake.url;
process.env.STRATA_API_KEY = "verify-team-key";

/** 盘上的原文（diff=0 的第三方参照物 —— 不走 HTTP）。 */
const rawRecords = async (sessionId: string): Promise<unknown[]> => {
  const store = createSqliteSessionStore(dataDir);
  try {
    return (await store.load(sessionId)).records;
  } finally {
    store.close();
  }
};
const openStore = () => createSqliteSessionStore(dataDir);

const BOSS_TOKEN = "sk-boss-verify-team";
const bossSession = taskSessionId("verify-boss");
const aliceSession = taskSessionId("verify-alice");

const server = await startAgentServer({
  port: 0,
  token: BOSS_TOKEN,
  /* 与 `ding serve` 同一条装配（`buildEngine`）；差别只有数据目录是临时目录 */
  makeEngine: async (cwd: string) => buildEngine([cwd], dataDir),
  /* 「按需确认」= 写工具要问一次 —— 审批那几条判据（待批归谁、谁能批）全靠这一档 */
  mode: "按需确认",
  provider: "strata",
  model: "deepseek-flash",
  cwd: dataDir,
  space: createSpaceStore(dataDir),
  /*
   * 审批那一族（C3 3.7b）：与 `ding serve` 同一套接线 ——
   * 索引常开（读"谁在等批"），写入复用会话库那一个端口（单一出口）。
   */
  approvals: createApprovalsIndex(dataDir, "sessions.db"),
  appendRecord: async (sessionId: string, record: unknown) => {
    const store = openStore();
    try {
      await store.append(sessionId, [record as never]);
    } finally {
      store.close();
    }
  },
  listSessions: async () => {
    const store = openStore();
    try {
      return await store.list();
    } finally {
      store.close();
    }
  },
  loadSession: async (sessionId: string) => {
    const store = openStore();
    try {
      return await store.load(sessionId);
    } finally {
      store.close();
    }
  },
  log: () => undefined,
});

const PORT = server.port;
const BOSS = BOSS_TOKEN;
console.log(`U8 验收：真起服务 http://127.0.0.1:${PORT}，假模型 ${fake.url}，数据目录 ${dataDir}\n`);

try {
  const A = (m: string, p: string, b?: unknown, t?: string) => api(PORT, m, p, b, t);
  /* ── 主人先有一段会话（真跑一轮，真落盘）────────────────── */
  const bossTurn = await turn(PORT, { message: "主人的第一句", sessionId: bossSession }, BOSS);
  ok(bossTurn.ok, `主人跑通第一轮（真引擎 + 真 SQLite）${bossTurn.ok ? "" : ` —— ${bossTurn.why}`}`);

  /* ── E2E-1 邀请与只读（U8-1）────────────────────────────── */
  console.log("\nE2E-1 邀请与只读（U8-1）");
  const invited = await A("POST", "/v1/space/invite", {}, BOSS);
  const code = String(invited.json.code ?? "");
  ok(invited.status === 200 && /^[0-9A-Z]{8}$/.test(code), `主人发出配对码（${code}）`);
  ok(Array.isArray(invited.json.roles) && (invited.json.roles as string[])[0] === "viewer", "配对默认给只读（viewer）");

  const joined = await api(PORT, "POST", "/v1/space/join", { code, memberId: "alice", displayName: "Alice" });
  const aliceToken = String(joined.json.token ?? "");
  ok(joined.status === 200 && aliceToken.startsWith("sk-"), "兑码入团，拿到属于她自己的口令");
  ok(((joined.json.member as { roles?: string[] })?.roles ?? [])[0] === "viewer", "只读起步");

  const aliceTurn = await turn(PORT, { message: "alice 的第一句", sessionId: aliceSession }, aliceToken);
  ok(aliceTurn.ok, `alice 跑通自己的一轮${aliceTurn.ok ? "" : ` —— ${aliceTurn.why}`}`);
  const aliceList = ((await A("GET", "/v1/sessions", undefined, aliceToken)).json.sessions ?? []) as Array<{ sessionId: string }>;
  const aliceIds = aliceList.map((s) => s.sessionId);
  ok(aliceIds.includes(aliceSession) && !aliceIds.includes(bossSession), "她只看得见自己的会话（主人的没在列表里）");
  ok((await A("POST", "/v1/run", { message: "插一句", sessionId: bossSession }, aliceToken)).status === 403, "往主人的会话里写：403（只读不是口号）");

  /* ── E2E-2 共享打开 + 重放 diff=0（U8-2）────────────────── */
  console.log("\nE2E-2 共享打开（U8-2：重放 diff=0）");
  ok((await A("GET", `/v1/sessions/${bossSession}/records`, undefined, aliceToken)).status === 403, "没共享就读不到（403）");
  ok((await A("POST", `/v1/space/share/${bossSession}`, undefined, BOSS)).status === 200, "主人把会话共享出去");
  const aliceView = await A("GET", `/v1/sessions/${bossSession}/records`, undefined, aliceToken);
  const bossView = await A("GET", `/v1/sessions/${bossSession}/records`, undefined, BOSS);
  const memberRecords = (aliceView.json.records ?? []) as unknown[];
  ok(aliceView.status === 200 && memberRecords.length > 0, `共享之后成员读得到（${memberRecords.length} 条）`);
  ok(JSON.stringify(memberRecords) === JSON.stringify(bossView.json.records ?? []), "成员读到的与主人读到的**逐字相同**");
  ok(JSON.stringify(memberRecords) === JSON.stringify(await rawRecords(bossSession)), "与**盘上原文**也逐字相同（diff=0）");

  /* ── E2E-3 接管与审批（U8-3）───────────────────────────── */
  console.log("\nE2E-3 接管与审批（U8-3）");
  const take = await A("POST", `/v1/space/takeover/${bossSession}`, undefined, aliceToken);
  ok(take.status === 200 && take.json.holder === "alice", "alice 接管（拿到写权）");
  const takenTurn = await turn(PORT, { message: "接管之后说一句", sessionId: bossSession }, aliceToken);
  ok(takenTurn.ok, `接管之后写得进去（那一轮跑完了）${takenTurn.ok ? "" : ` —— ${takenTurn.why}`}`);
  ok(
    findLast(await rawRecords(bossSession), (r) => r.type === "request")?.actor?.id === "alice",
    "那一轮的记录**真落进了**这段会话，且 actor = 接管人（归属不换主 = 记录不被本地库拒收）",
  );
  const bossList = ((await A("GET", "/v1/sessions", undefined, BOSS)).json.sessions ?? []) as Array<{ sessionId: string; owner: string }>;
  ok(bossList.find((s) => s.sessionId === bossSession)?.owner === "local", "接管是写权，不是所有权转移（摘要里仍归 local）");

  /* viewer 的写工具：**当场拒**（角色是上限）—— 接管给的写权不覆盖工具轴 */
  const viewerWrite = await turn(PORT, { message: `帮我${WRITE_MARK}`, sessionId: bossSession }, aliceToken);
  ok(viewerWrite.ok, `viewer 这一轮本身跑得完（拒绝是**结果**，不是崩溃）${viewerWrite.ok ? "" : ` —— ${viewerWrite.why}`}`);
  const viewerResult = findLast(await rawRecords(bossSession), (r) => r.type === "tool-result" && r.toolName === "write_file");
  ok(String(viewerResult?.error ?? "").includes("只读成员"), "viewer 调写工具：直接拒（那句人话里有「只读成员」）");
  ok(!existsSync(probePath(dataDir)), "被拒的写**没有执行**（探针文件不存在）");

  /* 升成 admin：同一个调用变成**待批**，而待批的人**只有会话主人** */
  ok((await A("POST", "/v1/space/members/alice/roles", { roles: ["admin"] }, BOSS)).status === 200, "主人把 alice 升成管理员（成员管理的角色那一格）");
  await sse(PORT, "/v1/run", { message: `帮我${WRITE_MARK}`, sessionId: bossSession }, aliceToken);
  const pendingPayload = findLast(await rawRecords(bossSession), (r) => r.type === "tool-result" && r.toolName === "write_file")?.output as
    | { pending?: boolean }
    | undefined;
  ok(pendingPayload?.pending === true, "admin 调写工具：待批（不是拒绝、更不是执行）");
  const approvers = approversOf(pendingPayload);
  ok(
    approvers.includes("local") && !approvers.includes("alice"),
    `待批归**会话主人**批（审批人：${approvers.join(" / ")}）—— 接管人不自动获得裁决权`,
  );
  const aliceDecide = canDecide({ approvers, actorId: "alice", alreadyDecided: false });
  ok(aliceDecide.ok === false && aliceDecide.code === "not-approver", "接管人想批自己那条：明确拒（not-approver）");
  ok(canDecide({ approvers, actorId: "local", alreadyDecided: false }).ok === true, "主人批：放行");
  ok(!existsSync(probePath(dataDir)), "待批期间写**同样没有执行**");

  /* ── E2E-4 授权他人批 ─────────────────────────────────── */
  console.log("\nE2E-4 授权他人批");
  const granted = authorizeApprover({ approvers, byActorId: "local", targetId: "alice" });
  ok(granted.ok === true && granted.added === true && granted.approvers.includes("alice"), "主人把自己的裁决权授给 alice");
  ok(
    granted.ok === true && canDecide({ approvers: granted.approvers, actorId: "alice", alreadyDecided: false }).ok === true,
    "授权之后 alice 就能批了（同一条待决、同一套核对）",
  );

  /* ── E2E-3b/4b 远端裁决（C3 3.7b 的服务端入口）────────── */
  console.log("\nE2E-3b/4b 远端裁决（HTTP：待决列表 / 授权 / 批准）");
  const listBefore = await A("GET", "/v1/approvals?state=pending", undefined, BOSS);
  ok(listBefore.status === 200, `待决列表读得到（${((listBefore.json.approvals ?? []) as unknown[]).length} 条）`);
  /* 之前那两轮 write_file 被拦下的待决（E2E-3 里验过它的审批人是主人） */
  const pendingRow = ((listBefore.json.approvals ?? []) as Array<{ toolCallId: string; youCanDecide: boolean; approvers: string[] }>).find(
    (row) => row.youCanDecide,
  );
  ok(Boolean(pendingRow), `主人能处置其中一条（审批人：${pendingRow?.approvers.join(" / ") ?? "?"}）`);
  if (pendingRow) {
    const granted = await A("POST", `/v1/approvals/${bossSession}/${pendingRow.toolCallId}`, { action: "authorize", target: "alice" }, BOSS);
    ok(granted.status === 200 && (granted.json.approvers as string[]).includes("alice"), "主人把裁决权授给 alice（HTTP 那条路）");
    const aliceCanNow = ((await A("GET", "/v1/approvals?state=pending", undefined, aliceToken)).json.approvals ?? []) as Array<{
      toolCallId: string;
      youCanDecide: boolean;
    }>;
    ok(aliceCanNow.find((row) => row.toolCallId === pendingRow.toolCallId)?.youCanDecide === true, "她那边现在显示「可以处置」");
    const decided = await A("POST", `/v1/approvals/${bossSession}/${pendingRow.toolCallId}`, { action: "reject" }, aliceToken);
    ok(decided.status === 200 && decided.json.state === "rejected" && decided.json.decidedBy === "alice", "她拒绝 → 留痕（decidedBy=alice）");
    const decisions = ((await rawRecords(bossSession)) as Array<{ type?: string; decidedBy?: string }>).filter((r) => r.type === "approval");
    ok(decisions.some((r) => r.decidedBy === "alice"), "那条决策记录真落了盘（谁批的可复盘）");
  }

  /* ── E2E-5 双端接管（fencing 语义）────────────────────── */
  console.log("\nE2E-5 双端接管（只有最后一个持有人写得进去）");
  const code2 = String((await A("POST", "/v1/space/invite", {}, BOSS)).json.code ?? "");
  const bobToken = String((await api(PORT, "POST", "/v1/space/join", { code: code2, memberId: "bob" })).json.token ?? "");
  const takeBob = await A("POST", `/v1/space/takeover/${bossSession}`, undefined, bobToken);
  ok(takeBob.status === 200 && takeBob.json.holder === "bob", "bob 接管（持有人换人）");
  ok((await A("POST", "/v1/run", { message: "alice 还想写", sessionId: bossSession }, aliceToken)).status === 403, "被换下来的持有人（alice）写不进去了");
  const bobTurn = await turn(PORT, { message: "现在的持有人是 bob", sessionId: bossSession }, bobToken);
  ok(bobTurn.ok, `当前持有人（bob）写得进去${bobTurn.ok ? "" : ` —— ${bobTurn.why}`}`);
  ok(findLast(await rawRecords(bossSession), (r) => r.type === "request")?.actor?.id === "bob", "bob 那一轮的记录也真落了盘（actor = bob）");

  /* ── E2E-6 成本分摊 ───────────────────────────────────── */
  console.log("\nE2E-6 成本分摊（按人算得清）");
  const usage = await A("GET", "/v1/usage", undefined, BOSS);
  const byMember = (usage.json.byMember ?? []) as Array<{ key: string; turns: number }>;
  const memberTurns = new Map(byMember.map((r) => [r.key, r.turns]));
  ok(usage.status === 200 && byMember.length >= 3, `账本按成员汇总（${byMember.map((r) => `${r.key}:${r.turns}`).join(" / ")}）`);
  ok(["local", "alice", "bob"].every((id) => (memberTurns.get(id) ?? 0) >= 1), "主人 / alice / bob 各人的轮数都 ≥ 1（钱算得到人头上）");
  ok(Number((usage.json.total as { turns?: number })?.turns ?? 0) >= 5, "合计轮数与真跑过的轮数对得上");
  ok((await A("GET", "/v1/usage", undefined, bobToken)).status === 403, "viewer 查不了账本（403）");
  ok((await A("GET", "/v1/usage", undefined, aliceToken)).status === 200, "管理员查得了（owner/admin 那条线）");
  const audit = await A("GET", "/v1/audit", undefined, BOSS);
  ok(audit.status === 200 && ((audit.json.entries ?? []) as unknown[]).length > 0, "审计面能扫出成员操作留痕（3.3）");

  /* ── E2E-8 多渠道触发 ─────────────────────────────────── */
  console.log("\nE2E-8 多渠道触发（一条消息 → 事件入流 → 回执）");
  const channel = await sse(PORT, "/v1/channels/wecom", { from: "zhangsan", text: "群里问一句" }, BOSS);
  const started = channel.find((f) => f.event === "started")?.data ?? {};
  ok(started.channel === "wecom" && started.from === "zhangsan", "渠道与发送者进了首帧（三层身份的 end_user）");
  ok(started.sessionId === "ch-wecom-zhangsan", `会话按「渠道 + 人」各段（${String(started.sessionId)}）`);
  ok(channel.some((f) => f.event === "event"), "事件进了流");
  ok(String(channel.find((f) => f.event === "done")?.data.reply ?? "").length > 0, "回执（done.reply）非空 —— 桥能把它发回群里");

  /* ── E2E-7 撤权即时生效（U8-5）───────────────────────── */
  console.log("\nE2E-7 撤权即时生效（U8-5）");
  ok((await A("DELETE", "/v1/space/members/bob", undefined, BOSS)).status === 200, "主人移除 bob");
  ok((await A("GET", "/v1/space", undefined, bobToken)).status === 401, "他的口令**下一个请求**就失效（401）");
  ok((await api(PORT, "POST", "/v1/run", { message: "还想跑一轮" }, bobToken)).status === 401, "跑一轮同样 401");
  ok((await A("GET", "/v1/space", undefined, aliceToken)).status === 200, "别人的口令不受影响");
} catch (error) {
  bad.push(`异常中断：${String((error as Error)?.message ?? error).slice(0, 200)}`);
} finally {
  await server.stop();
  await fake.close();
  try {
    rmSync(dataDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  } catch {
    /* 尽力而为（Windows 上文件可能还被某个连接占着） */
  }
}

console.log("");
if (bad.length) {
  console.error(`✗ U8 验收有 ${bad.length} 条不过：\n${bad.map((b) => `  · ${b}`).join("\n")}`);
  process.exitCode = 1;
} else {
  console.log("✓ U8 验收全过（E2E-1/2/3/4/5/6/7/8）—— 团队可用的机器证据");
}
