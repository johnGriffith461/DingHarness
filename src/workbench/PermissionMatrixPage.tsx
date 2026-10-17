import { useState } from "react";

import { CONFIRM_MODES, type ConfirmMode } from "@shared/ipc";
import { MEMBER_ROLES, ROLE_LABEL } from "@engine/core/members";
import { NavCollapseButton } from "./NavCollapseButton";
import { ComputerUseCard } from "./ComputerUseCard";
import { VERDICT_LABEL, matrixRows, verdictHint, type Verdict } from "./permissionMatrix";

/**
 * 两轴权限矩阵（V6-2i / V6-4d）。
 *
 * 工具轴（档位：全部允许 / 按需确认 / 每步确认）× 人轴（角色：所有者 / 管理员 /
 * 专家 / 只读成员）。**每一格都来自内核的 `decideForMember`** ——
 * 这一页是"把内核的判定画出来"，不是另写一套规则。
 *
 * 只读：内核的策略表是代码里的静态表（改它要改代码 + 契约测试），
 * 这里**不放假开关**。能做到的是"看清现在是什么规矩"。
 */

const VERDICT_STYLE: Record<Verdict, { bg: string; fg: string }> = {
  run: { bg: "rgba(46, 160, 67, 0.16)", fg: "#2ea043" },
  ask: { bg: "rgba(210, 153, 34, 0.18)", fg: "#b08800" },
  hide: { bg: "rgba(120, 120, 120, 0.14)", fg: "var(--muted, #888)" },
  deny: { bg: "rgba(218, 54, 51, 0.16)", fg: "#da3633" },
};

export function PermissionMatrixPage() {
  const [mode, setMode] = useState<ConfirmMode>("按需确认");
  const rows = matrixRows(mode);

  return (
    <div className="wb-setpage-body" data-testid="wb-permissions">
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <NavCollapseButton />
        {CONFIRM_MODES.map((item) => (
          <button
            key={item}
            type="button"
            className="wb-chip"
            data-testid={`wb-perm-mode-${item}`}
            aria-pressed={mode === item}
            onClick={() => setMode(item)}
          >
            {item}
          </button>
        ))}
      </div>

      <p className="wb-setpage-note">
        <strong>角色是上限，档位是旋钮</strong>：档位只能在角色允许的范围内收紧或放松。
        所以「只读成员」的写操作在「全部允许」档下**也拒** —— 那一档说的是"我信这个模型"，
        不是"改写文件的人是谁"。
      </p>
      <p className="wb-setpage-note">
        `不给模型`（hide）与角色无关：工具压根没注入，模型不知道它存在。这一页是**只读**的 ——
        改规矩要改策略表与 ADR，不在这里放一个假开关。
      </p>

      <table className="wb-team-usage" data-testid="wb-perm-table">
        <thead>
          <tr>
            <th align="left">工具</th>
            <th align="left">种类</th>
            {MEMBER_ROLES.map((role) => (
              <th key={role} align="center">
                {ROLE_LABEL[role]}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.tool} data-testid={`wb-perm-row-${row.tool}`}>
              <td>
                <code>{row.tool}</code>
              </td>
              <td>{row.kind === "read" ? "只读" : "写 / 执行"}</td>
              {MEMBER_ROLES.map((role) => {
                const verdict = row.cells[role];
                const style = VERDICT_STYLE[verdict];
                return (
                  <td key={role} align="center" title={verdictHint(verdict, role, row.kind)}>
                    <span
                      data-testid={`wb-perm-${row.tool}-${role}`}
                      data-verdict={verdict}
                      style={{
                        display: "inline-block",
                        padding: "2px 8px",
                        borderRadius: 999,
                        fontSize: 12,
                        background: style.bg,
                        color: style.fg,
                      }}
                    >
                      {VERDICT_LABEL[verdict]}
                    </span>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>

      <p className="wb-setpage-note" data-testid="wb-perm-legend">
        图例：放行 = 直接执行；要确认 = 这一次调用等用户/审批人点头；
        直接拒 = 不执行也不交审批（让模型尽早知道这条路走不通）；不给模型 = 工具没注入。
      </p>

      <ComputerUseCard />
    </div>
  );
}
