/**
 * 从 `Workbench.tsx` 拆出来的（C6-1）。**纯挪位**：一个字没改，只加了 export 与 import。
 * 拆的理由原本记在 `docs/PLAN-C6-结构拆分.md`：那个文件 2188 行、14 个顶层组件，
 * ⚠️（该依据未入库、本机也找不到 —— 决策链断在这里，无法复核；以本文件里的断言与实现为准）
 * 改一处要读两千行 —— 于是「顺手加一行」变成默认做法。
 */

import { useWorkbenchStore } from "./store";
import { splitSuggestion } from "./copy";
import { suggestionIcon } from "./suggestionIcon";

import { Composer } from "./Composer";

export function HomeView() {
  const suggestions = useWorkbenchStore((s) => s.suggestions);
  const createTask = useWorkbenchStore((s) => s.createTask);

  return (
    <section className="wb-home" data-testid="wb-home">
      <div className="wb-home-scroll">
        <div className="wb-blob" aria-hidden />
        <h1 className="wb-home-title">今天有什么工作要处理?</h1>
        <div className="wb-home-label">为你推荐</div>
        <div className="wb-suggestions">
          {suggestions.map((raw) => {
            /*
             * 形态照本体首页实机截图：一行是「类目图标 + 类目 + 指令」。
             * 之前渲染的是**一整条字符串**（`PPT 制作一份 TED 风格演讲`）+ 一枚统一的 ✨，
             * 与实机不像：本体每个类目**各自一枚图标**，且类目与指令是两段。
             */
            const { tag, text } = splitSuggestion(raw);
            const Icon = suggestionIcon(tag);
            return (
              <button
                key={raw}
                className="wb-suggestion"
                data-testid={`wb-suggestion-${tag}`}
                onClick={() => void createTask(raw)}
              >
                <span className="wb-suggestion-icon" aria-hidden>
                  <Icon size={11} />
                </span>
                <span className="wb-suggestion-tag">{tag}</span>
                {text ? <span className="wb-suggestion-text">{text}</span> : null}
              </button>
            );
          })}
        </div>
      </div>
      <Composer />
    </section>
  );
}

/* ============================================================
 * 右侧「对话摘要」面板
 * ============================================================ */

/**
 * 右侧「对话摘要」面板。
 *
 * 上位这里是**四个 tab** —— 从它的 i18n 表里读到（`sidePanel_summary_tab_*`）：
 * `产物 / 浏览器 / 图片与视频 / 子智能体`。我早期只做了「对话产物」一块，
 * 那是把其中一个 tab 当成了整个面板。
 *
 * 「产物」是真文件（阶段 11.1/11.2）：任务产出后落到 `<userData>/artifacts/`，
 * 点标题用系统默认程序打开、点图标在文件管理器里定位。
 */
