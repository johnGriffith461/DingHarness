import { Gauge } from "lucide-react";
import { usageRows, usageTotal, type StepUsage } from "@shared/cost";
import { clockOf } from "./duration";

/**
 * 输入区里的「用量」：一个按钮 + 一块明细（2026-10-14 主人点名要的）。
 *
 * ## 形态出处
 * 照 Ding Harness 原型的**上下文容量弹层**（`dingwork-app.html` 的 `.ctx-btn` / `.ctx-pop`）：
 * 输入条右端一颗小按钮，点开一块 **272px** 的弹层，里面是「标题 + 若干行 + 页脚」，
 * 值走等宽字体 + `tabular-nums`（数一变就抖的毛病在这条上最明显）。
 *
 * ## 与原型**有意不同**的一处（必须说清）
 * 原型那块的头部是一条「上下文容量 75.9万/100万（75.9%）」的**进度条**。
 * 本机版**没有模型窗口大小这个常量** —— 填一个数进去就是编的（本仓库对"消耗/用量"
 * 这类数的规矩见 `shared/cost.ts` 的开头：宁可没有，不许编）。
 * 所以这里只显示**真实用量**那几行；进度条等有了真窗口值再加。
 *
 * ## 行从哪来
 * 全部由 `usageRows()` 从一份 `StepUsage` 生成（口径只有那一处）：
 * 缓存读取 / 未缓存输入 / 缓存命中 / 缓存写入 / 输出 / 吞吐量。
 * **provider 没给的行就不出现** —— 页面不会出现"0"去冒充"没有数据"。
 */
export function UsagePopover({
  usage,
  open,
  onToggle,
}: {
  usage?: StepUsage;
  open: boolean;
  onToggle: () => void;
}) {
  const rows = usageRows(usage);
  const total = usageTotal(usage);
  const seconds = typeof usage?.elapsedMs === "number" ? usage.elapsedMs / 1000 : null;

  return (
    <div className="wb-chip-wrap">
      <button
        className={`wb-chip${open ? " is-on" : ""}`}
        data-testid="wb-usage"
        aria-expanded={open}
        title="Token 用量（provider 给的真实值）"
        onClick={onToggle}
      >
        {/* T-12：口径写清是「本段对话」（与用量页/团队账本不是同一个范围） */}
        <Gauge size={12} /> 本段对话
        {total === null ? null : <em className="wb-chip-badge">{total >= 10000 ? `${(total / 10000).toFixed(1)}万` : total}</em>}
      </button>
      {open ? (
        <div className="wb-usage-pop" data-testid="wb-usage-pop">
          <div className="wb-usage-head">
            <b>本段对话的 Token 用量</b>
            <span className="mono">{seconds === null ? "本次对话" : `时长 ${clockOf(seconds)}`}</span>
          </div>
          {rows.length === 0 ? (
            <div className="wb-usage-empty" data-testid="wb-usage-empty">
              还没有真实用量：provider 没给就没得显示（跑一次任务后再看）。
            </div>
          ) : (
            <div className="wb-usage-rows" data-testid="wb-usage-rows">
              {rows.map((row) => (
                <div className="wb-usage-row" key={row.key} title={row.note}>
                  <span className="v">{row.value}</span>
                  <span className="k">{row.label}</span>
                  <span className="point" aria-hidden />
                </div>
              ))}
            </div>
          )}
          <div className="wb-usage-foot">
            <span>真实用量</span>
            <span className="mono">{total === null ? "—" : `${total} tokens`}</span>
          </div>
        </div>
      ) : null}
    </div>
  );
}
