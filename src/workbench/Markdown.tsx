import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

/**
 * T-03：助手回答的 Markdown 渲染（**只开 GFM，不开原始 HTML**）。
 *
 * ## 为什么用成熟实现
 *
 * 自己写解析器是"看起来能跑"的典型：加粗、列表、代码块能对付，
 * 但嵌套、表格、引用、转义、链接安全这些边界一条条都要自己补 ——
 * 而用户每天都在把模型输出粘进来。react-markdown + remark-gfm 是这条路上
 * 最常见、也最容易被审计的一套。
 *
 * ## XSS 的底线
 *
 * **不启用 `rehype-raw`**：react-markdown 默认把原始 HTML 当**文本**输出，
 * 于是 `<img onerror=…>` 不会变成标签、更不会执行。
 * 这一条有单测钉着（`markdown.test.ts` 的第三个用例），改配置前先想清楚。
 *
 * ⚠️ 用户消息**不用它**（`TaskView` 里用户气泡仍是纯文本）：
 * 用户写什么是他的自由，不该被当 Markdown 解释。
 */

export function Markdown({ text }: { text: string }) {
  return (
    <div className="wb-md" data-testid="wb-md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        /* 外链：新窗口 + 不带 referrer（与常见 harness 同一口径） */
        components={{
          a: ({ href, children }) => (
            <a href={href} target="_blank" rel="noreferrer noopener">
              {children}
            </a>
          ),
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}
