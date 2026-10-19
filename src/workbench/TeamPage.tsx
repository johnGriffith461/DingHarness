import { useCallback, useEffect, useState } from "react";
import { KeyRound, RefreshCw, Trash2, UserMinus } from "lucide-react";

import { MEMBER_ROLES, type MemberRole } from "@engine/core/members";
import { LocalOnlyNote } from "./LocalOnlyNote";

/**
 * **设置 → 团队空间**（V5-3 3.1/3.2/3.4 的产品面；V5 收尾补）。
 *
 * 在这之前，团队能力**只有服务端**（`/v1/space/*`）—— 发码、入团、共享、接管、
 * 查账本都得 curl。这一页把同一件事接到界面上，操作的是**本机数据目录里的
 * `space.json`**（与 `ding space` 与 `ding serve` 同一个账本）。
 *
 * 三条如实呈现的边界（不画假的按钮）：
 * 1. **口令只在入团那一次显示** —— 服务端不提供"再读一次"（口令可读回 = 泄露即冒充）；
 * 2. `join` 是**替你入团**：主人在这台机器上兑码、拿口令、私下交给那个人；
 *    被邀请的人自己兑码走 `POST /v1/space/join`（`ding serve` 那条路）；
 * 3. **接管**在这里是主人代设持有人（成员自己接管走 HTTP）—— 与 `ding space takeover` 一致。
 */

/** 与主进程 `spaceHost.ts` 的视图同形（那边是真相，这里只管显示）。 */
type SpaceState = {
  owner: string;
  members: Array<{ id: string; kind: string; displayName: string; roles: string[]; joinedAt: number; isOwner: boolean }>;
  shared: string[];
  holders: Record<string, string>;
  pendingCodes: Array<{ code: string; roles: string[]; expiresAt: number }>;
  /** 端到端加密房间：**只有房间号**（密钥在链接的 # 后面，账本里没有） */
  rooms: Array<{ sessionId: string; roomId: string }>;
  file: string;
};

type ActionResult = { ok: true; note: string; token?: string; code?: string; state: SpaceState } | { ok: false; error: string };

const ROLE_LABEL: Record<string, string> = {
  owner: "所有者",
  admin: "管理员",
  specialist: "专家",
  viewer: "只读",
};

/** 主进程那三个接口（`window.ding.space.*`；preload 里挂的）。 */
type SpaceApi = {
  state: () => Promise<SpaceState>;
  shareableSessions: () => Promise<Array<{ sessionId: string; title: string; owner: string; updatedAt: number }>>;
  openRoom: (sessionId: string) => Promise<{ ok: true; roomId: string; fragment: string; note: string } | { ok: false; error: string }>;
  invite: (roles?: string[]) => Promise<ActionResult>;
  join: (request: { code: string; memberId: string; displayName?: string }) => Promise<ActionResult>;
  setRoles: (memberId: string, roles: string[]) => Promise<ActionResult>;
  remove: (memberId: string) => Promise<ActionResult>;
  share: (sessionId: string) => Promise<ActionResult>;
  unshare: (sessionId: string) => Promise<ActionResult>;
  takeover: (sessionId: string, memberId: string) => Promise<ActionResult>;
  usage: () => Promise<{ turns: number; byMember: Array<{ key: string; turns: number; totalTokens: number | null }>; inputTokens: number; outputTokens: number }>;
};

/**
 * 主进程那座桥挂在 **`window.shell`** 上（`electron/preload.ts` 的
 * `exposeInMainWorld("shell", api)`）—— 不是 `window.ding`。
 * 拿不到就如实说"这个宿主没接"（不画假按钮）。
 */
function spaceApi(): SpaceApi | null {
  const shell = (globalThis as unknown as { shell?: { space?: SpaceApi } }).shell;
  return shell?.space ?? null;
}

export function TeamPage() {
  const [state, setState] = useState<SpaceState | null>(null);
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  /** 入团那一刻的口令（**只显示这一次** —— 存到 state 里，刷新就没了）。 */
  const [token, setToken] = useState("");
  const [code, setCode] = useState("");
  const [memberId, setMemberId] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [usage, setUsage] = useState<Awaited<ReturnType<SpaceApi["usage"]>> | null>(null);
  /** 可以共享的会话（**问本机库要**，见 `spaceHost.shareableSessions` 的说明）。 */
  const [candidates, setCandidates] = useState<Array<{ sessionId: string; title: string; owner: string }>>([]);
  const [pick, setPick] = useState("");

  const refresh = useCallback(async () => {
    const api = spaceApi();
    if (!api) {
      setError("这个宿主没有接团队空间（window.shell.space 不在）—— 命令行那条路是 `ding space`");
      return;
    }
    try {
      setState(await api.state());
      setCandidates(await api.shareableSessions().catch(() => []));
      setError("");
    } catch (err) {
      setError(String((err as Error)?.message ?? err));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  /** 统一收尾：成功显示 note（口令/码单独给），失败显示原因。 */
  const apply = (got: ActionResult): void => {
    if (got.ok) {
      setState(got.state);
      setNote(got.note);
      setError("");
      if (got.token) setToken(got.token);
      if (got.code) setCode(got.code);
    } else {
      setError(got.error);
      setNote("");
    }
  };

  if (!state) {
    return (
      <div className="wb-setpage-body" data-testid="wb-team">
        <p className="wb-setpage-note">{error || "正在读团队空间的账本…"}</p>
        <button type="button" className="wb-chip" data-testid="wb-team-refresh" onClick={() => void refresh()}>
          <RefreshCw size={14} /> 重新读取
        </button>
      </div>
    );
  }

  const api = spaceApi();
  const rolesOf = (id: string): string[] => state.members.find((m) => m.id === id)?.roles ?? [];

  return (
    <div className="wb-setpage-body" data-testid="wb-team">
      {/*
        T-13：原来这一行把 `space.json` 叫"账本"，但成本数字实际来自本机会话库。
        两件事分开写，避免用户拿着 space.json 找不到成本、或以为成本存在那里。
      */}
      <p className="wb-setpage-note" data-testid="wb-team-paths">
        空间主人：<strong>{state.owner}</strong>
      </p>
      <p className="wb-setpage-note" data-testid="wb-team-roster-file">
        名册与口令：{state.file ? <code>{state.file}</code> : "还没开过空间（首次邀请后生成）"}
      </p>
      <p className="wb-setpage-note" data-testid="wb-team-cost-source">
        成本数字：来自本机会话库（<code>sessions.db</code>），不在名册文件里。
      </p>
      {/* T-11：团队空间的边界与替代 */}
      <LocalOnlyNote
        testId="wb-team-localonly"
        title="团队空间是本机数据 + 配对码"
        why="没有云端后端：名册与口令写在本机，成员通过配对码连到这台机器（或同一局域网的 Agent Server）。"
        alternative={<>本机替代：单人使用时用「用量与追踪」看本机成本；多人协作需要跑 <code>ding serve</code>。</>}
      />

      {note ? <p className="wb-setpage-note" data-testid="wb-team-note">{note}</p> : null}
      {error ? <p className="wb-setpage-note wb-team-error" data-testid="wb-team-error">{error}</p> : null}
      {token ? (
        <p className="wb-setpage-note wb-team-warn" data-testid="wb-team-token">
          <KeyRound size={14} /> {memberId || "新成员"} 的口令（只显示这一次，请私下交给他）：<code>{token}</code>
        </p>
      ) : null}
      {code ? (
        <p className="wb-setpage-note" data-testid="wb-team-code">
          配对码：<code>{code}</code>（10 分钟、一码一人；把它发给要入团的人）
        </p>
      ) : null}

      {/* ── 名册 ───────────────────────────────────────── */}
      <h4>成员（{state.members.length}）</h4>
      <ul className="wb-card wb-team-members" data-testid="wb-team-members">
        {state.members.map((m) => (
          <li key={m.id} className="wb-card-row" data-testid={`wb-team-member-${m.id}`}>
            <span className="wb-card-label">
              {m.displayName}
              {m.displayName === m.id ? "" : `（${m.id}）`}
              {m.isOwner ? "　· 主人" : ""}
            </span>
            <span className="wb-card-desc" data-testid={`wb-team-roles-${m.id}`}>{m.roles.map((r) => ROLE_LABEL[r] ?? r).join(" / ") || "（无）"}</span>
            {m.isOwner ? null : (
              <>
                <select
                  aria-label={`${m.id} 的角色`}
                  data-testid={`wb-team-role-${m.id}`}
                  value={m.roles[0] ?? "viewer"}
                  onChange={(e) => {
                    if (!api) return;
                    void api.setRoles(m.id, [e.target.value]).then(apply);
                  }}
                >
                  {MEMBER_ROLES.filter((r: MemberRole) => r !== "owner").map((r: MemberRole) => (
                    <option key={r} value={r}>
                      {ROLE_LABEL[r] ?? r}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  className="wb-icon"
                  data-testid={`wb-team-remove-${m.id}`}
                  title="移除（口令同时作废：他下一个请求就 401）"
                  onClick={() => {
                    if (!api) return;
                    void api.remove(m.id).then(apply);
                  }}
                >
                  <UserMinus size={14} /> 移除
                </button>
              </>
            )}
          </li>
        ))}
      </ul>

      {/* ── 发码 / 入团 ───────────────────────────────── */}
      <h4>邀请与入团</h4>
      <div className="wb-card-row">
        {(["viewer", "specialist", "admin"] as MemberRole[]).map((role) => (
          <button
            key={role}
            type="button"
            className="wb-chip"
            data-testid={`wb-team-invite-${role}`}
            onClick={() => {
              if (!api) return;
              void api.invite([role]).then(apply);
            }}
          >
            发一张码（{ROLE_LABEL[role] ?? role}）
          </button>
        ))}
      </div>
      <div className="wb-card-row">
        <input data-testid="wb-team-code-input" placeholder="配对码" value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} aria-label="配对码" />
        <input data-testid="wb-team-member-input" placeholder="成员 id（如 alice）" value={memberId} onChange={(e) => setMemberId(e.target.value)} aria-label="成员 id" />
        <input data-testid="wb-team-name-input" placeholder="显示名（可选）" value={displayName} onChange={(e) => setDisplayName(e.target.value)} aria-label="显示名" />
        <button
          type="button"
          className="wb-chip"
          data-testid="wb-team-join"
          disabled={!code.trim() || !memberId.trim()}
          onClick={() => {
            if (!api) return;
            void api
              .join({ code: code.trim(), memberId: memberId.trim(), ...(displayName.trim() ? { displayName: displayName.trim() } : {}) })
              .then(apply);
          }}
        >
          替他入团（拿口令）
        </button>
      </div>
      <p className="wb-setpage-note" data-testid="wb-team-pending">
        未用的码：{state.pendingCodes.length ? state.pendingCodes.map((c) => `${c.code}（${c.roles.join("/")}）`).join("　") : "（没有）"}
      </p>

      {/* ── 共享与持有人 ──────────────────────────────── */}
      <h4>共享出去的会话（{state.shared.length}）</h4>
      {/* 共享入口：挑一段本机会话 → 共享出去（成员就能读到，要写得先接管） */}
      <div className="wb-card-row">
        <select
          aria-label="挑一段会话共享"
          data-testid="wb-team-share-pick"
          value={pick}
          onChange={(e) => setPick(e.target.value)}
        >
          <option value="">挑一段会话…</option>
          {candidates
            .filter((c) => !state.shared.includes(c.sessionId))
            .map((c) => (
              <option key={c.sessionId} value={c.sessionId}>
                {c.title}（{c.sessionId}）
              </option>
            ))}
        </select>
        <button
          type="button"
          className="wb-chip"
          data-testid="wb-team-share"
          disabled={!pick}
          onClick={() => {
            if (!api || !pick) return;
            void api.share(pick).then((got) => {
              setPick("");
              apply(got);
            });
          }}
        >
          共享出去
        </button>
        <span className="wb-card-desc">
          {candidates.length ? "（列的是本机库里的会话）" : "（本机还没有会话可以共享）"}
        </span>
      </div>
      {state.shared.length === 0 ? (
        <p className="wb-setpage-note">还没有共享任何会话（命令行那条路是 `ding space share` 加会话 id）。</p>
      ) : (
        <ul className="wb-card wb-team-shared" data-testid="wb-team-shared">
          {state.shared.map((id) => (
            <li key={id} className="wb-card-row" data-testid={`wb-team-shared-${id}`}>
              <code>{id}</code>
              <span className="wb-card-desc">持有人：{state.holders[id] ?? "（还没人接管，成员只能读）"}</span>
              <select
                aria-label={`${id} 的接管人`}
                value={state.holders[id] ?? ""}
                onChange={(e) => {
                  if (!api || !e.target.value) return;
                  void api.takeover(id, e.target.value).then(apply);
                }}
              >
                <option value="">指定持有人…</option>
                {state.members
                  .filter((m) => !m.isOwner)
                  .map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.id}
                    </option>
                  ))}
              </select>
              <button
                type="button"
                className="wb-icon"
                data-testid={`wb-team-unshare-${id}`}
                title="取消共享（持有人一并清掉）"
                onClick={() => {
                  if (!api) return;
                  void api.unshare(id).then(apply);
                }}
              >
                <Trash2 size={14} /> 取消共享
              </button>
              {/* 角色的当前值给"改角色"的 select 用（这里只是把它读出来给上面） */}
              <span hidden>{rolesOf(id).join(",")}</span>
            </li>
          ))}
        </ul>
      )}

      {/* ── 端到端加密房间（V5-2 2.4 的产品面）────────── */}
      <h4>端到端加密房间（{state.rooms.length}）</h4>
      {state.rooms.length === 0 ? (
        <p className="wb-setpage-note">
          还没有房间。房间里传的内容是**端到端加密**的（密钥只在链接的 # 后面，服务端收不到）；
          而审批、接管这类控制事件保持明文 —— 它们要能被路由。
        </p>
      ) : (
        <ul className="wb-card wb-team-rooms" data-testid="wb-team-rooms">
          {state.rooms.map((room) => (
            <li key={room.sessionId} className="wb-card-row" data-testid={`wb-team-room-${room.sessionId}`}>
              <code>{room.roomId}</code>
              <span className="wb-card-desc">E2EE　会话 {room.sessionId}</span>
            </li>
          ))}
        </ul>
      )}
      <div className="wb-card-row">
        <select aria-label="给哪段会话建房间" data-testid="wb-team-room-pick" value={pick} onChange={(e) => setPick(e.target.value)}>
          <option value="">挑一段已共享的会话…</option>
          {state.shared
            .filter((id) => !state.rooms.some((room) => room.sessionId === id))
            .map((id) => (
              <option key={id} value={id}>
                {id}
              </option>
            ))}
        </select>
        <button
          type="button"
          className="wb-chip"
          data-testid="wb-team-room-open"
          disabled={!pick}
          onClick={() => {
            if (!api || !pick) return;
            void api.openRoom(pick).then((got) => {
              setPick("");
              if (got.ok) {
                setNote(got.note);
                void refresh();
              } else setError(got.error);
            });
          }}
        >
          建一个加密房间
        </button>
      </div>

      {/* ── 账本（按成员）────────────────────────────── */}
      <h4>团队账本（按成员；范围是团队空间，不是「本段对话」）</h4>
      <div className="wb-card-row">
        <button
          type="button"
          className="wb-chip"
          data-testid="wb-team-usage"
          onClick={() => {
            if (!api) return;
            void api.usage().then((got) => {
              setUsage(got);
              setNote(`账本：${got.turns} 轮（数字只来自 provider 上报，拿不到就留空）`);
            });
          }}
        >
          按成员算一遍
        </button>
      </div>
      {usage ? (
        <table className="wb-team-usage" data-testid="wb-team-usage-table">
          <thead>
            <tr>
              <th>成员</th>
              <th>轮数</th>
              <th>token</th>
            </tr>
          </thead>
          <tbody>
            {usage.byMember.map((row) => (
              <tr key={row.key}>
                <td>{row.key}</td>
                <td>{row.turns}</td>
                <td>{row.totalTokens ?? "（未上报）"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
    </div>
  );
}

export default TeamPage;
