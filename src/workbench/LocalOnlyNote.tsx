import type { ReactNode } from "react";
import { Info } from "lucide-react";

/**
 * T-11：**本机版不可用/只读能力**的统一说明块。
 *
 * ## 为什么统一
 *
 * 六个入口原来各写各的（有的写"本机版没有X"，有的写"暂不支持"，有的干脆
 * 只显示一个 `—`）。用户看到的不是"一条清晰的边界"，而是六种不同语气的借口。
 *
 * ## 三条规矩（照方案 §T-11）
 *
 * 1. **一句话说清是什么**（标题）；
 * 2. **为什么**（本机版没有服务端/没有配套 App/数据来自本机日志）；
 * 3. **本机替代方案**（能做什么，而不是只说不做什么）。
 *
 * 纯展示组件：不带状态、不发请求，任何页面都能安全使用。
 */
export function LocalOnlyNote({
  title,
  why,
  alternative,
  testId,
}: {
  title: string;
  why: string;
  /** 本机能做的那一条（不说"替代"也行，直接写能做的事）。 */
  alternative?: ReactNode;
  testId?: string;
}) {
  return (
    <div className="wb-localonly" data-testid={testId ?? "wb-localonly"} role="note">
      <Info size={14} className="wb-localonly-icon" aria-hidden />
      <div className="wb-localonly-body">
        <strong>{title}</strong>
        <span>{why}</span>
        {alternative ? <em>{alternative}</em> : null}
      </div>
    </div>
  );
}
