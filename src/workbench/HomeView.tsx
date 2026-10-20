/**
 * 从 `Workbench.tsx` 拆出来的（C6-1）。**纯挪位**：一个字没改，只加了 export 与 import。
 * 拆的理由原本记在 `docs/PLAN-C6-结构拆分.md`：那个文件 2188 行、14 个顶层组件，
 * ⚠️（该依据未入库、本机也找不到 —— 决策链断在这里，无法复核；以本文件里的断言与实现为准）
 * 改一处要读两千行 —— 于是「顺手加一行」变成默认做法。
 */

import { useEffect, useState } from "react";
import type { RouteDiagnosis } from "@shared/routeDiagnosis";
import { diagnoseRouteNow } from "@/ai/route";
import { useWorkbenchStore } from "./store";
import { HOME_MODES, HOME_TITLE, splitSuggestion } from "./copy";
import { suggestionIcon } from "./suggestionIcon";

import { Composer } from "./Composer";
import { NavCollapseButton } from "./NavCollapseButton";

export function HomeView() {
  const suggestions = useWorkbenchStore((s) => s.suggestions);
  const homeMode = useWorkbenchStore((s) => s.homeMode);
  const setHomeMode = useWorkbenchStore((s) => s.setHomeMode);
  const createTask = useWorkbenchStore((s) => s.createTask);
  /*
   * F-03：首页也照实说"现在走不通、下一步点哪"。
   * 只在**阻塞型**诊断时显示（`no_pinned` 只是提示，自动挑选仍可能成功）。
   */
  const [blocked, setBlocked] = useState<RouteDiagnosis | null>(null);
  useEffect(() => {
    let alive = true;
    void diagnoseRouteNow()
      .then((d) => {
        if (alive && d.blocking) setBlocked(d);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);

  return (
    <section className="wb-home" data-testid="wb-home">
      {/*
        ⚠️ 2026-10-19（主人实测撞到的死路）：左栏收起后，首页**没有**展开入口。
        别的页面都把 `NavCollapseButton` 挂在页头，唯独首页没有 —— 而收起状态是
        持久化的，于是"在任务页点了收起 → 回到首页"就再也打不开左栏（只剩命令面板里那条）。
        这里补上同一个组件（一处实现，文案与图标不另写一份）。
      */}
      <div className="wb-home-tools">
        <NavCollapseButton />
      </div>
      {blocked ? (
        <div className="wb-route-fix wb-home-route-fix" data-testid="wb-home-route-fix">
          <div className="wb-route-fix-text">
            <strong>现在还不能开始任务</strong>
            <span data-testid="wb-home-route-fix-message">{blocked.message}</span>
          </div>
          {blocked.action ? (
            <button
              className="wb-tool-btn is-primary"
              data-testid="wb-home-route-fix-action"
              onClick={() =>
                window.dispatchEvent(
                  new CustomEvent("dsh-open-settings", { detail: { page: blocked.action?.page ?? "models" } }),
                )
              }
            >
              {blocked.action.label}
            </button>
          ) : null}
        </div>
      ) : null}
      <div className="wb-home-scroll">
        <div className="wb-blob" aria-hidden />
        {/*
          D02（2026-10-18）：首屏先问"你是哪种工作"。
          原来只有一句"今天有什么工作要处理?"，推荐卡里一半是 PPT/Word、
          一半是画布 —— 开发者和办公用户都觉得不像自己。选完模式再出卡片。
        */}
        <div className="wb-home-mode" role="group" aria-label="工作模式">
          {HOME_MODES.map((mode) => (
            <button
              key={mode.id}
              type="button"
              className="wb-home-mode-btn"
              data-testid={`wb-home-mode-${mode.id}`}
              aria-pressed={homeMode === mode.id}
              onClick={() => setHomeMode(mode.id)}
            >
              {mode.label}
            </button>
          ))}
        </div>
        <h1 className="wb-home-title">{HOME_TITLE[homeMode]}</h1>
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
