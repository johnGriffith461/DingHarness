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

      {/*
        T-15：把"角色是上限，档位是旋钮"这种写给开发者的措辞，
        改成用户能直接对照自己处境的三句话（机制一个字没动）。
      */}
      <p className="wb-setpage-note" data-testid="wb-perm-plain">
        <strong>这一页只回答一件事：你点某个档位之后，会发生什么。</strong>
        「只读成员」即使选了「全部允许」，也依然不能改文件 —— 因为他本来就没有这个权限；
        「全部允许」只表示"你信任这个模型、不再逐步确认"，不是"给谁换了个身份"。
        「接受编辑」比「按需确认」少问一类：**工作区里的文件编辑**直接做；
        跑命令、调用连接器、以及 `.env` / `.git` / `node_modules` / 工作区外的路径**仍然会问**。
        表里按工具种类画的格子是这一档的默认；具体到某一次编辑还要看它写的是哪个路径。
      </p>
      <p className="wb-setpage-note" data-testid="wb-perm-readonly">
        标着「不给模型」的工具，模型**根本看不到**，所以不会点了没反应。
        这一页是只读说明：想改规则要改后端的策略表（不是界面上漏了个开关）。
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
