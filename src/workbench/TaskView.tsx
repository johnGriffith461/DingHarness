/**
 * 从 `Workbench.tsx` 拆出来的（C6-1）。**纯挪位**：一个字没改，只加了 export 与 import。
 * 拆的理由见 `docs/PLAN-C6-结构拆分.md`：那个文件 2188 行、14 个顶层组件，
 * 改一处要读两千行 —— 于是「顺手加一行」变成默认做法。
 */

import { useEffect, useRef, useState } from "react";
import { ChevronRight, Clock, HelpCircle, Monitor, Phone, PanelLeft } from "lucide-react";
import { useWorkbenchStore } from "./store";
import { currentQuestion, progressLabel } from "./task";
import { ToolTraceList } from "./ToolTraceList";
import { ArtifactCard } from "./ArtifactCard";

import { useTick } from "./NavSidebar";
import { PenIcon } from "./uiUtil";
import { QuestionCard } from "./QuestionCard";
import { MessageActions } from "./MessageActions";
import { Composer } from "./Composer";

export function TaskView() {
  const task = useWorkbenchStore((s) => s.tasks.find((t) => t.id === s.activeTaskId) ?? null);
  const tick = useTick(task?.stage === "running");
  const scroller = useRef<HTMLDivElement | null>(null);
  const openFloat = useWorkbenchStore((s) => s.openFloat);
  const scheduleFromTask = useWorkbenchStore((s) => s.scheduleFromTask);
  const renameTask = useWorkbenchStore((s) => s.renameTask);
  /** 放行/拒绝被闸门拦下的工具调用（§144）。 */
  const resolveTool = useWorkbenchStore((s) => s.resolveTool);
  /** 在这段对话里接着说一句（§147）。 */
  const sendInTask = useWorkbenchStore((s) => s.sendInTask);
  /** 标题改名：点标题进入，回车/失焦提交。 */
  const [renaming, setRenaming] = useState(false);

  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: "smooth" });
  }, [task?.steps.length, task?.stage]);

  if (!task) return <div className="wb-empty">没有打开的任务</div>;

  const progress = progressLabel(task, tick);

  return (
    <section className="wb-task" data-testid="wb-task">
      <header className="wb-task-head">
        {/*
          ⚠️ 这个按钮**标了 disabled**（§124 的死按钮审计报出来的）。

          它原本是个没有 onClick 的死按钮，而且**图标也不太对**
          （在"打开/收起左侧栏"的位置放了个 MoreHorizontal）。

          查过了：**项目里没有侧栏折叠机制**（store 与 Workbench 里都搜不到
          navCollapsed / navOpen 之类）。所以它不是"漏接线"，是**参考里有、
          我还没做**的功能。

          按本项目标准"如实呈现，不装作能用"，没实现的就不该可点 ——
          所以标 disabled，并把它记进待做（R5 视觉/体验收口）。
        */}
        <button className="wb-icon" aria-label="打开/收起左侧栏" title="打开/收起左侧栏（本机版还没做折叠）" disabled>
          <PanelLeft size={15} />
        </button>
        {/*
          重命名：原来是个**没有 onClick 的死按钮**（§124 审计报出）——
          而它要唤起的能力**早就做好了**：`renaming` state 与下面的
          `wb-task-rename-input` 都在，只是没人把 `setRenaming(true)` 接到这个按钮上。
        */}
        <button
          className="wb-icon"
          aria-label="重命名" title="重命名"
          data-testid="wb-task-rename"
          onClick={() => setRenaming(true)}
        >
          <PenIcon />
        </button>
        <div className="wb-task-title">
          {renaming ? (
            <input
              className="wb-task-rename"
              data-testid="wb-task-rename-input"
              autoFocus
              defaultValue={task.title}
              onBlur={(e) => {
                renameTask(task.id, e.target.value);
                setRenaming(false);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  renameTask(task.id, e.currentTarget.value);
                  setRenaming(false);
                }
                if (e.key === "Escape") setRenaming(false);
              }}
            />
          ) : (
            /*
             * 实机里任务标题是**可点的**（标题后面跟一个 ›）。
             * 点它进入改名，比在旁边放个铅笔更顺 —— 铅笔那个是"编辑任务内容"，不是改标题。
             */
            <button
              className="wb-task-title-btn"
              data-testid="wb-task-title"
              title="点击重命名任务"
              onClick={() => setRenaming(true)}
            >
              {task.title} <span className="wb-task-title-tail">›</span>
            </button>
          )}
          <em>AI 生成可能有误 请核实</em>
        </div>
        {/*
          顶栏右侧那一排图标。实机第 3 个是**弹出悬浮助手窗**（独立可拖拽的快速问答面板）。
          其余几个（电话/定时/设备）是远端能力，这里只做图标占位，不做假功能。
        */}
        <button className="wb-icon" aria-label="语音通话" title="语音通话（未接入）" disabled>
          <Phone size={15} />
        </button>
        {/*
          ⏰ 用它把当前任务变成定时任务：跳到定时任务页并把标题与要做的事填好。
          **不直接建**：点一下凭空多出一个每天跑的任务会让人意外，
          建不建交给用户在表单里确认。
        */}
        <button
          className="wb-icon"
          aria-label="用这个任务建一个定时任务" title="用这个任务建一个定时任务"
          data-testid="wb-task-schedule"
          onClick={() => scheduleFromTask(task.title, task.brief)}
        >
          <Clock size={15} />
        </button>
        <button
          className="wb-icon"
          aria-label="打开悬浮助手窗" title="打开悬浮助手窗（随手问，不建任务）"
          data-testid="wb-float-open"
          onClick={() => openFloat()}
        >
          <Monitor size={15} />
        </button>
      </header>

      <div className="wb-stream" ref={scroller} data-testid="wb-stream">
        {task.steps.map((step) =>
          step.role === "user" ? (
            <div className="wb-bubble-user" key={step.id}>
              {step.text}
            </div>
          ) : (
            <div className="wb-assistant" key={step.id}>
              <div className="wb-assistant-text">{step.text}</div>
              {/*
                这一步用过的工具（§141）。
                放在正文**下面**：模型"调了工具"这件事用户得看得见 ——
                否则"记忆被写进去了"就是暗箱操作。这与本项目反复清的
                "看着有、其实没用"是反方向的要求：**真做了的事要看得出来**。
              */}
              {/* 工具留痕（§141/§185）：抽成了共享组件，聊天那边用同一个 */}
              <ToolTraceList
                id={step.id}
                traces={step.tools ?? []}
                onResolve={(toolCallId, approve) => void resolveTool(task.id, step.id, toolCallId, approve)}
              />
              {/*
                这一步额外要说的一件事（§149）：目前用于"更早的对话已压缩为摘要"。
                挂在步骤上而不是飘一个 toast —— 飘提示刷新就没了，
                回头翻这段对话会不知道当时上下文被压过。
              */}
              {step.note ? (
                <div className="wb-step-note" data-testid={`wb-note-${step.id}`}>
                  {step.note}
                </div>
              ) : null}
              {/* 这一步产出的产物：卡片就贴在这句话下面 */}
              {task.artifacts
                .filter((a) => a.stepId === step.id)
                .map((artifact) => (
                  <ArtifactCard key={artifact.id} artifact={artifact} />
                ))}
              <MessageActions taskId={task.id} step={step} cost={step.cost} at={step.at} />
            </div>
          ),
        )}

        {progress ? (
          /*
            `preamble-elapsed-timer` 是上位的稳定契约属性（自动化与埋点都挂在它上面），
            照抄下来，别人的脚本能直接对得上。
          */
          <div className="wb-progress" data-testid="wb-progress" data-preamble-elapsed-timer={task.stage}>
            <span data-testid="preamble-elapsed-timer">{progress}</span>
            {task.finishedAt !== null ? <ChevronRight size={13} /> : null}
          </div>
        ) : null}

        {task.activity && task.stage !== "done" ? (
          <div className="wb-activity">
            <HelpCircle size={13} /> {task.activity}
          </div>
        ) : null}
        {/*
          ⭐ **流式正文**（2026-10-14 补）：在此之前工作台流式时只有上面那行「正在回复」，
          整段回答**结束时才蹦出来**（聊天侧一直是逐字显示的 —— 两边手感不一致）。
          草稿挂在任务上（`task.draft`），收尾时由 `runStream` 清掉、正文落成正式的一步。
          `data-testid` 给验收用：`accept-abort.mjs` 靠它断言"文字真的在一个个长出来"。
        */}
        {task.draft ? (
          <div className="wb-assistant wb-draft" data-testid="wb-draft-text">
            <div className="wb-assistant-text">
              {task.draft}
              <span className="wb-caret" aria-hidden />
            </div>
          </div>
        ) : null}
      </div>

      {currentQuestion(task) ? <QuestionCard task={task} /> : null}

      {/*
        ⭐ 任务视图的输入框是**接着聊**，不是新开一段（§147）。

        这里原来就是一个默认的 `<Composer />` —— 于是用户在对话里接着说一句，
        应用会**新建一个任务**，之前那几轮完全不在上下文里。
        本体不是这样（它的「主对话」是一段多轮对话）。
      */}
      <Composer onSend={(value, options) => void sendInTask(task.id, value, options)} />
    </section>
  );
}

/** 铅笔图标（lucide 的 Pen 在此处只用到一次，内联省一次 import）。 */
