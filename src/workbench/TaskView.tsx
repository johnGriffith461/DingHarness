/**
 * 从 `Workbench.tsx` 拆出来的（C6-1）。**纯挪位**：一个字没改，只加了 export 与 import。
 * 拆的理由原本记在 `docs/PLAN-C6-结构拆分.md`：那个文件 2188 行、14 个顶层组件，
 * ⚠️（该依据未入库、本机也找不到 —— 决策链断在这里，无法复核；以本文件里的断言与实现为准）
 * 改一处要读两千行 —— 于是「顺手加一行」变成默认做法。
 */

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { ChevronRight, Clock, HelpCircle, Monitor, RotateCcw } from "lucide-react";
import { NavCollapseButton } from "./NavCollapseButton";
import { useWorkbenchStore } from "./store";
import { continueTargetOf, currentQuestion, progressLabel } from "./task";
import { ToolTraceList } from "./ToolTraceList";
import { ChangeReviewPanel } from "./ChangeReviewPanel";
import { BULK_ACCEPT_NOTE, KEEP_ASKING_NOTE, countEditAsks, hasPendingEdit, shouldOfferBulkAccept } from "./confirmFatigue";
import { readConfirmMode, saveConfirmMode, subscribeConfirmMode } from "./confirmMode";
import { normalizeTaskSessionId } from "./sessionId";
import { ArtifactCard } from "./ArtifactCard";

import { useTick } from "./NavSidebar";
import { PenIcon } from "./uiUtil";
import { QuestionCard } from "./QuestionCard";
import { MessageActions } from "./MessageActions";
import { Composer } from "./Composer";
import { PlanPanel } from "./PlanPanel";
import { StepAttachments } from "./StepAttachments";
import { TodoPanel } from "./TodoPanel";
import { Markdown } from "./Markdown";

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
  /** P0-04：待验证计划的执行与跳过。 */
  const runVerification = useWorkbenchStore((s) => s.runVerification);
  const skipVerification = useWorkbenchStore((s) => s.skipVerification);
  /** F-04：确认疲劳逃生门。 */
  const markBulkAcceptOffered = useWorkbenchStore((s) => s.markBulkAcceptOffered);
  const noteTask = useWorkbenchStore((s) => s.noteTask);
  const confirmMode = useSyncExternalStore(subscribeConfirmMode, readConfirmMode, readConfirmMode);
  /** 被中断的那一轮该继续什么（见 `task.ts` 的 `continueTargetOf`）。 */
  const interruptedTarget = task ? continueTargetOf(task) : null;
  /** 标题改名：点标题进入，回车/失焦提交。 */
  const [renaming, setRenaming] = useState(false);

  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: "smooth" });
  }, [task?.steps.length, task?.stage]);

  if (!task) return <div className="wb-empty">没有打开的任务</div>;

  const progress = progressLabel(task, tick);
  /*
   * F-04：同一个任务里第 3 次待批编辑 → 提示一次「本会话自动接受」。
   * 计数按任务算（`task.steps`），换任务自然归零；点哪个按钮都算"已提示"。
   */
  const offerBulkAccept =
    hasPendingEdit(task.steps) &&
    shouldOfferBulkAccept({
      editsAsked: countEditAsks(task.steps),
      alreadyOffered: task.bulkAcceptOffered === true,
      mode: confirmMode,
    });

  return (
    <section className="wb-task" data-testid="wb-task">
      <header className="wb-task-head">
        {/*
          收起左栏（2026-10-15，M0 工单 3）。原来这里是一颗 `disabled` 的死按钮，
          注释里写着"项目里没有侧栏折叠机制" —— 那是当时的实情，
          但它是工单点名的 26 处死控件里出现次数最多的那一颗（当时几个页面各写一遍）。
          现在共用 `NavCollapseButton`：一处实现，文案只写一份。
          ⚠️ 引用点清单在 `store.ts` 的 `navCollapsed` 注释里（P193 会对账）；
          别照旧数字找 —— 任务中心从来就没有这颗按钮，首页 2026-10-19 才补上。
        */}
        <NavCollapseButton />
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
        {/* 本段对话的逐文件改动（U08）：默认收起，展开才读日志 */}
        <ChangeReviewPanel sessionId={normalizeTaskSessionId(task.id)} />
        {/*
          顶栏右侧那一排图标。实机第 3 个是**弹出悬浮助手窗**（独立可拖拽的快速问答面板）。
          其余几个（电话/定时/设备）是远端能力，这里只做图标占位，不做假功能。
        */}
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

      {/* P0-01：待办面板（只读；没有待办时不渲染） */}
      <TodoPanel steps={task.steps} />

      {/* G1：右侧计划面板（只在计划状态时出现；流区域仍占满剩余宽度） */}
      <div className="wb-task-body">
        <div className="wb-stream" ref={scroller} data-testid="wb-stream">
        {task.steps.map((step) =>
          step.role === "user" ? (
            <div className="wb-bubble-user" key={step.id}>
              {/* G2：附件缩略图（重启后按路径读回；被清理时显示占位） */}
              <StepAttachments attachments={step.attachments ?? []} />
              {step.text}
            </div>
          ) : (
            <div className="wb-assistant" key={step.id}>
              <div className="wb-assistant-text">
                <Markdown text={step.text} />
              </div>
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
                /* 「总是允许」（U03）：放行这一次并记一条长期规则（重启仍生效） */
                onAlwaysAllow={(toolCallId) => void resolveTool(task.id, step.id, toolCallId, true, { remember: true })}
                /* 授权记录要落进这段会话（与 `resolveTool` 那条路同一个 id 口径，见 `store.ts`） */
                grantSessionId={normalizeTaskSessionId(task.id)}
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

        {/*
          F-04：确认疲劳的逃生门。第 3 次待批编辑时出现一次；
          「本会话自动接受」只改这一档（不写长期配置），命令仍会逐条问。
        */}
        {offerBulkAccept ? (
          <div className="wb-confirm-fatigue" data-testid="wb-confirm-fatigue">
            <div className="wb-confirm-fatigue-text">
              这一轮已经问了你 {countEditAsks(task.steps)} 次编辑。要不要本会话内自动接受编辑（命令仍会问）？
            </div>
            <div className="wb-confirm-fatigue-actions">
              <button
                className="wb-tool-btn is-primary"
                data-testid="wb-bulk-accept"
                onClick={() => {
                  /* F-04：**只在本会话生效**（不写长期配置，重启回到原档） */
                  saveConfirmMode("接受编辑", { sessionOnly: true });
                  markBulkAcceptOffered(task.id);
                  noteTask(task.id, BULK_ACCEPT_NOTE);
                }}
              >
                本会话自动接受
              </button>
              <button
                className="wb-tool-btn"
                data-testid="wb-bulk-keep"
                onClick={() => {
                  markBulkAcceptOffered(task.id);
                  noteTask(task.id, KEEP_ASKING_NOTE);
                }}
              >
                继续逐次问
              </button>
            </div>
          </div>
        ) : null}

        {/*
          F-03：**没有可用通道**不是一句"出错了"就结束 —— 给出诊断与可点的下一步。
          按钮直接打开 设置 → 模型（那里既有 key 输入也有模型清单），不是一句正确的废话。
        */}
        {task.routeDiagnosis ? (
          <div className="wb-route-fix" data-testid="wb-route-fix">
            <div className="wb-route-fix-text">
              <strong>这一轮没有发出去</strong>
              <span data-testid="wb-route-fix-message">{task.routeDiagnosis.message}</span>
            </div>
            {task.routeDiagnosis.action ? (
              <button
                className="wb-tool-btn is-primary"
                data-testid="wb-route-fix-action"
                onClick={() =>
                  window.dispatchEvent(
                    new CustomEvent("dsh-open-settings", {
                      detail: { page: task.routeDiagnosis?.action?.page ?? "models" },
                    }),
                  )
                }
              >
                {task.routeDiagnosis.action.label}
              </button>
            ) : null}
          </div>
        ) : null}

        {/*
          P0-04：改完文件但当前档位不自动跑命令时，这里出一张卡片。
          「运行验证」走的仍是 run_command 的同一条执行通道（不是第二条路径）。
        */}
        {task.stage === "verify_ready" && task.verifyPlan ? (
          <div className="wb-verify-card" data-testid="wb-verify-card">
            <div className="wb-verify-text">
              <strong>已改文件，等待验证</strong>
              <code data-testid="wb-verify-command">{task.verifyPlan.command}</code>
              <span>
                {task.verifyPlan.reason}
                {task.verifyPlan.rounds > 0 ? `（已运行 ${task.verifyPlan.rounds}/2 次）` : ""}
              </span>
            </div>
            <div className="wb-verify-actions">
              <button
                className="wb-tool-btn is-primary"
                data-testid="wb-verify-run"
                onClick={() => void runVerification(task.id)}
              >
                运行验证
              </button>
              <button className="wb-tool-btn" data-testid="wb-verify-skip" onClick={() => skipVerification(task.id)}>
                跳过
              </button>
            </div>
          </div>
        ) : null}

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
            {/*
              ⭐ **一键继续**（Phase 12.2 的桌面端入口）。
              被中断的回合在库里是半截的（请求在、答案不在），原来这里只说一句
              "上次关闭时被中断" 就没了 —— 用户得自己把上次那句话再打一遍。
              现在给一颗按钮：把**上次那句原话**重发一轮（历史都在，所以新一轮看得到
              "上次做到哪"）。

              ⚠️ 如实说明：这是**重发**，不是"续写半句" —— 上游没有续写半轮这回事，
              点它 = 这一轮重新计费。所以按钮的 title 里写清了。
            */}
            {interruptedTarget ? (
              <button
                className="wb-chip wb-continue"
                data-testid="wb-task-continue"
                title="重新跑一轮（不是续写半句：这一轮会重新计费）"
                disabled={task.stage === "running" || Boolean(task.draft)}
                onClick={() => void sendInTask(task.id, interruptedTarget)}
              >
                <RotateCcw size={12} /> 继续
              </button>
            ) : null}
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
        <PlanPanel task={task} />
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
