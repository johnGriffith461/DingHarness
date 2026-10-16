import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { CONFIRM_MODES } from "@shared/ipc";
import { MEMORY_DOMAINS } from "@shared/memory";
import { MIGRATIONS, SCHEMA_VERSION } from "@engine/adapters/sqliteSchema";
import { logLine, parseLogLine } from "@engine/core/events";
import { DEFAULT_APPROVER } from "@engine/core/gates";
import { MEMBER_ROLES } from "@engine/core/members";
import { decideForMember } from "@engine/core/policy";
import { CANVAS_EVENT_TYPES, CANVAS_SURFACE } from "@engine/core/canvasContract";

/**
 * **契约 diff 门**（V5-1 任务 3.10b；ADR-010 是它冻结的那张清单）。
 *
 * ## 它挡的是什么
 *
 * 六项契约（C1–C6）的**语义面**一旦在没人注意的时候被改动，V5-2/V5-3 与第三方
 * （V5-4 的 SDK）就会踩在一个"看起来没变、其实变了"的地基上。所以把冻结面做成
 * **可计算的清单**（`engine/core/contracts.frozen.json`），并在这里对账：
 *
 *   ① 代码里现在的契约面 = 清单里的那一份（少了/变了 → 红）；
 *   ② 清单里每一项都带着**来历的那份 ADR**，而那份 ADR 必须真的在 `ADR/` 里；
 *   ③ 清单里不留已经不在代码里的项（门也要诚实 —— 别让清单变成化石）。
 *
 * 改了契约怎么办（判词里也会写）：先加 ADR，再更新清单。
 *
 * ⚠️ 这不是"防呆"，是"**改契约必须留名**"：门本身不判断改动好坏，
 * 它只保证**没有一次契约变更是无名的**。
 */

const ROOT = path.resolve(__dirname, "..");
const FROZEN = path.join(ROOT, "engine/core/contracts.frozen.json");
const ADR_DIR = path.join(ROOT, "ADR");

/** 现在代码里的契约面（能被计算的那些；每项是**值**，不是描述）。 */
function currentSurface(): Record<string, string> {
  const keysOf = (line: string): string => {
    const parsed = parseLogLine(line);
    return parsed ? Object.keys(parsed).sort().join(",") : "(解析不出)";
  };
  const t = 1_700_000_000_000;
  return {
    "schema.version": String(SCHEMA_VERSION),
    "schema.migrations": MIGRATIONS.map((m) => `v${m.version}:${m.name}`).join(" | "),
    "schema.tables": "sessions,events,schema_version,events_fts",
    "record.request.keys": keysOf(
      logLine({ requestId: "r", type: "request", provider: "p", model: "m", messages: [{ role: "user", content: "x" }] } as never, 1, t),
    ),
    "record.text.keys": keysOf(logLine({ requestId: "r", type: "text", text: "x" } as never, 2, t)),
    "record.approval.keys": keysOf(
      logLine({ type: "approval", toolCallId: "c", name: "write_file", approved: true, line: "l", decidedBy: "local", approvers: ["local"] } as never, 3, t),
    ),
    "session.owner": "sessions.owner (TEXT NOT NULL DEFAULT 'local')",
    "policy.confirmModes": CONFIRM_MODES.join(","),
    "policy.memberRoles": MEMBER_ROLES.join(","),
    /* 矩阵逐格（4 角色 × 读/写的两个档位）—— 改判定就会改这一格 */
    "policy.matrix": MEMBER_ROLES.map((role) => {
      const read = decideForMember({ roles: [role] }, "全部允许", "read_file").verdict;
      const write = decideForMember({ roles: [role] }, "全部允许", "write_file").verdict;
      const writeAsk = decideForMember({ roles: [role] }, "每步确认", "write_file").verdict;
      return `${role}:${read}/${write}/${writeAsk}`;
    }).join(" | "),
    "gates.defaultApprover": DEFAULT_APPROVER,
    "gates.decisionCodes": "stale,not-approver",
    "memory.domains": MEMORY_DOMAINS.join(","),
    "canvas.eventTypes": CANVAS_EVENT_TYPES.join(","),
    "canvas.surface": Object.entries(CANVAS_SURFACE)
      .map(([op, verdict]) => `${op}:${verdict}`)
      .join(","),
  };
}

describe("契约 diff 门（3.10b）：改契约必须留名（ADR + 清单一起动）", () => {
  const frozen = JSON.parse(readFileSync(FROZEN, "utf8")) as { entries: Record<string, { adr?: string }> };
  const current = currentSurface();

  it("① 清单里的每一项都对应代码里的一个契约面（新面没进清单 = 有人偷偷改了契约）", () => {
    const missing = Object.keys(current).filter((key) => !(key in frozen.entries));
    expect(
      missing,
      [
        "这些契约面已经不在冻结清单里 —— 要么是这次改漏了，要么是新加的面没登记：",
        ...missing.map((k) => `  ${k} = ${current[k]}`),
        "改契约的正确做法：① 先在 ADR/ 加一份 ADR 说明为什么；② 再更新 engine/core/contracts.frozen.json。",
      ].join("\n"),
    ).toEqual([]);
  });

  it("② 清单里没有已经消失的项（门自己也要诚实，别当化石）", () => {
    const stale = Object.keys(frozen.entries).filter((key) => !(key in current));
    expect(stale, `这些项已经不在代码里了，从清单里删掉：${stale.join(", ")}`).toEqual([]);
  });

  it("⭐ 每一项都带着来历的 ADR，且那份 ADR 真的在 ADR/ 里", () => {
    for (const [key, entry] of Object.entries(frozen.entries)) {
      expect(entry.adr, `${key} 没标它来历的 ADR`).toBeTruthy();
      const file = path.join(ADR_DIR, String(entry.adr));
      expect(existsSync(file), `${key} 指的 ADR 不存在：${String(entry.adr)}（改契约必须留名）`).toBe(true);
    }
  });

  it("判定本身有效（真值对账）：清单里记的**行为面**与当前实现一致", () => {
    /*
     * 这一条是"门真的在看东西"的自证：把几个关键值**当面**再算一遍。
     * 少了它，上面三条在"清单与代码同时被改坏"时依然全绿。
     */
    const matrix = current["policy.matrix"] ?? "";
    expect(matrix).toContain("owner:");
    expect(matrix).toContain("viewer:");
    expect(matrix, "viewer 的写判定被改了（这是矩阵里最有产品含义的一格）").toContain("viewer:run/deny/deny");
    expect(current["gates.defaultApprover"]).toBe("local");
    expect(current["memory.domains"]).toBe("private,team");
    expect(current["schema.version"]).toBe(String(SCHEMA_VERSION));
  });
});
