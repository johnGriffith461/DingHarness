import { usageTotal, type StepUsage } from "@shared/cost";

import { ContextMeterBar } from "./ContextMeterBar";

/**
 * 输入框**下面那一行字**（2026-10-22 主人）：
 * 「本段对话这个按钮取消 把里面内容放到对话框的下面 写着输出多少 Token 输入多少 Token
 * 包括的对话用量内容」。
 *
 * 所以这里没有按钮、没有弹层：就是一行静态文字。
 * 数值来自 provider 真实上报的 usage（`@shared/cost` 的 `usageTotal`，与用量页同一口径）；
 * 没跑过就说"还没有"，不编 0。
 */
function fmt(n: number | undefined): string {
  if (typeof n !== "number") return "";
  return n >= 10000 ? `${(n / 10000).toFixed(1)}万` : String(n);
}

export function ComposerUsageLine({ usage }: { usage?: StepUsage }) {
  const total = usageTotal(usage);
  const input = usage?.inputTokens;
  const output = usage?.outputTokens;
  const text =
    total === null
      ? "还没有 Token 用量（跑一次后显示）"
      : [
          typeof input === "number" ? `输入 ${fmt(input)}` : "",
          typeof output === "number" ? `输出 ${fmt(output)}` : "",
          `合计 ${fmt(total)} tokens`,
        ]
          .filter(Boolean)
          .join(" · ");

  return (
    <div className="wb-composer-usage" data-testid="wb-composer-usage">
      <ContextMeterBar />
      <span className="wb-usage-inline" data-testid="wb-usage-inline" title="本段对话的真实用量（provider 上报）">
        {text}
      </span>
    </div>
  );
}
