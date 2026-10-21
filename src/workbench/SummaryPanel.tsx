/**
 * 从 `Workbench.tsx` 拆出来的（C6-1）。**纯挪位**：一个字没改，只加了 export 与 import。
 * 拆的理由原本记在 `docs/PLAN-C6-结构拆分.md`：那个文件 2188 行、14 个顶层组件，
 * ⚠️（该依据未入库、本机也找不到 —— 决策链断在这里，无法复核；以本文件里的断言与实现为准）
 * 改一处要读两千行 —— 于是「顺手加一行」变成默认做法。
 */

import { useState } from "react";
import { FolderOpen, PanelRight, PanelRightClose, Plus } from "lucide-react";
import { useWorkbenchStore, openArtifact, revealArtifact } from "./store";
import { findItemIn, useLibraryStore } from "./libraryStore";
import { enabledSkillNames, recentFilesOf } from "./summaryData";
import { ARTIFACT_TITLE_GENERATING, SUMMARY_RECENT_FILES, SUMMARY_RECENT_LIMIT_NOTE, SUMMARY_SESSION_FILES, SUMMARY_TABS, type SummaryTabId } from "./copy";
import { resourceTypeOf } from "@shared/artifactProto";
import { ARTIFACT_FORMATS } from "./artifact";

import { formatBytes } from "./uiUtil";
import { MediaTab } from "./MediaTab";

export function SummaryPanel({
  collapsed,
  onCollapsedChange,
}: {
  /**
   * 是否收起。
   *
   * ⚠️ 它**由工作台持有**（2026-10-15，M0 工单 2）：Esc 要能收起这个面板，
   * 而 Esc 的判定必须在**一处**做 —— 两个右侧面板各自监听同一个按键，
   * 就会出现"一次 Esc 关掉两个"或"关哪个看注册顺序"（见 `Workbench.tsx` 的 Esc 处理）。
   */
  collapsed: boolean;
  /** 收起态变化（展开浮标 / 头上的「收起」都会调它）。 */
  onCollapsedChange: (collapsed: boolean) => void;
}) {
  const task = useWorkbenchStore((s) => s.tasks.find((t) => t.id === s.activeTaskId) ?? null);
  /* P82：技能与最近文件都从已有数据推（不新增状态），见 summaryData.ts 的文件头 */
  const lib = useLibraryStore((s) => s.lib);
  const enabledSkills = enabledSkillNames(lib, (id) => findItemIn(lib, id)?.name);
  const recentFiles = recentFilesOf(task);
  const [tab, setTab] = useState<SummaryTabId>("artifacts");
  const [opening, setOpening] = useState<string | null>(null);
  const [note, setNote] = useState<string>("");
  /*
   * 面板**默认收起**（2026-10-14）。这一颗按钮原来写着 `disabled` + "本机版还没做面板折叠" ——
   * Ding Harness 原型里右栏是默认收起的（塌成右缘一条竖直把手，点开才展开），
   * 主人 2026-10-14 点名要这个口径。
   *
   * ⚠️ 代价是**4 条验收脚本原来直接点 `wb-summary-tab-*`**（artifacts / emptystates /
   * media / workbench），默认收起会让它们一起红 —— 已在 `harness.mjs` 里加了
   * `openSummary(page)`（与 `openCanvas` 同一个理由：别让 4 处各写一遍"先展开再点"），
   * 那 4 条各调一次。默认值现在由 `Workbench` 那边给。
   */

  const artifacts = task?.artifacts ?? [];

  return (
    <aside className={`wb-summary${collapsed ? " is-collapsed" : ""}`} data-testid="wb-summary">
      {collapsed ? (
        <button
          className="wb-summary-handle"
          data-testid="wb-summary-expand"
          aria-label="展开对话摘要"
          title="展开对话摘要"
          onClick={() => onCollapsedChange(false)}
        >
          {/* 图标正立、文字竖排 —— 原型就是分两段做的（`.re-ic` / `.re-tx`）；
              图标走 lucide（`uiCraft.test.ts ⑦` 明令不许用 Unicode 字形顶图标） */}
          <PanelRight size={14} />
          <span>面板</span>
        </button>
      ) : (
        /*
         * ⚠️ 2026-10-16（主人的话）：「点面板是打开，但打开之后**根本没有显示关闭的面板按钮**；
         * 打开画布又有了，有了之后你会发现它的面板按钮**还在最右侧，没有跟着侧边栏动**」。
         *
         * 收起态那颗「面板」把手点了能打开，但**打开之后原位没有对应的收起入口** ——
         * 原型那边是直接把它 `display: none` 的（`.rail-open .rail-edge`），关只能去头部找。
         *
         * 现在做成**对称**的：展开时在面板**左缘**挂一条竖排「收起」，
         * 与收起态的把手同一套尺寸/样式/位置口径（竖直居中、贴面板那条边）——
         * 面板在哪儿、多宽，它就贴在哪条边上，**跟着面板走**，不再是一颗飘在别处的小箭头。
         */
        <button
          className="wb-summary-edge"
          data-testid="wb-summary-edge"
          aria-label="收起对话摘要"
          title="收起对话摘要"
          onClick={() => onCollapsedChange(true)}
        >
          <PanelRightClose size={14} />
          <span>收起</span>
        </button>
      )}

      <header className="wb-summary-head">
        <span>对话摘要</span>
        {/*
          ⚠️ 这里原来是「摘要设置」的死按钮（`disabled` + "本机版没有后端"）。
          2026-10-15（M0 工单 3）按工单口径**移除** —— 摘要没有可设的项，
          摆一颗点不动的齿轮只会让人以为摘要功能坏了。
        */}
        {/*
          2026-10-22 主人：「我是让你删右上角的那个小收起，而不是删面板那个大收起」——
          这里原本还有一颗小的「收起」（图标 + 两个字），与左缘那条竖排大字重复。
          删掉这颗，只留左缘那条（它跟着面板边走动，更好认）。
        */}
      </header>

      <div className="wb-tabs wb-summary-tabs" data-testid="wb-summary-tabs">
        {SUMMARY_TABS.map((t) => (
          <button
            key={t.id}
            className={`wb-tab${tab === t.id ? " is-on" : ""}`}
            data-testid={`wb-summary-tab-${t.id}`}
            title={t.key}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === "artifacts" ? (
        <div className="wb-summary-section">
          <div className="wb-summary-title">
            {SUMMARY_SESSION_FILES} <Plus size={13} />
          </div>
          {/* 上位说明：面板只扫会话里最近若干条消息的产物 */}
          <div className="wb-summary-desc" data-testid="wb-summary-desc">
            {SUMMARY_RECENT_LIMIT_NOTE}
          </div>
          {artifacts.length === 0 ? (
            <div className="wb-summary-empty" data-testid="wb-artifacts-empty">
              {task && task.stage === "done" ? "暂无产物" : "暂无"}
            </div>
          ) : (
            <div className="wb-artifacts" data-testid="wb-artifacts">
              {artifacts.map((artifact) => (
                <div className="wb-artifact" key={artifact.id} data-testid={`wb-artifact-${artifact.id}`}>
                  <button
                    className="wb-artifact-main"
                    title={artifact.filePath ?? "尚未落盘"}
                    /* 上位产物卡的稳定钩子之一，埋点与自动化都依赖它 */
                    data-office-artifact-card-kind={artifact.kind}
                    /*
                     * 协议类型编号。**两处渲染都要给** ——
                     * 同一份产物既出现在对话流里、也出现在右侧「对话产物」里，
                     * 只给一处的话，靠这个属性做的检查会随"看的是哪一处"而结论不同。
                     */
                    data-artifact-resource-type={resourceTypeOf(artifact.kind)}
                    onClick={() => {
                      if (!artifact.filePath) {
                        setNote("这个产物还没落盘");
                        return;
                      }
                      setOpening(artifact.id);
                      void openArtifact(artifact.filePath)
                        .then((error) => setNote(error ? `打不开：${error}` : ""))
                        .finally(() => setOpening(null));
                    }}
                  >
                    <span className={`wb-artifact-kind is-${artifact.kind}`}>
                      {ARTIFACT_FORMATS[artifact.kind].label}
                    </span>
                    <span className="wb-artifact-title">{artifact.title}</span>
                    <span className="wb-artifact-status" data-office-artifact-status={artifact.status}>
                      {artifact.status === "generating" ? ARTIFACT_TITLE_GENERATING : ""}
                    </span>
                    {opening === artifact.id ? <em className="wb-artifact-size">打开中…</em> : null}
                    {typeof artifact.bytes === "number" && opening !== artifact.id ? (
                      <em className="wb-artifact-size">{formatBytes(artifact.bytes)}</em>
                    ) : null}
                  </button>
                  <button
                    className="wb-icon"
                    aria-label="在文件夹里定位" title="在文件夹里定位"
                    data-testid={`wb-artifact-reveal-${artifact.id}`}
                    onClick={() => {
                      if (artifact.filePath) void revealArtifact(artifact.filePath);
                    }}
                  >
                    <FolderOpen size={12} />
                  </button>
                </div>
              ))}
            </div>
          )}
          {note ? (
            <div className="wb-summary-note" data-testid="wb-artifact-note">
              {note}
            </div>
          ) : null}
        </div>
      ) : tab === "media" ? (
        <MediaTab />
      ) : (
        <div className="wb-summary-section">
          <div className="wb-summary-title">{SUMMARY_TABS.find((t) => t.id === tab)?.label}</div>
          {/*
            这两个 tab 如实说明为什么是空的。

            ⚠️ 2026-10-13 更正一处**不实陈述**：子智能体那一句原来写着
            「本次实现不含子智能体调度」—— 而子智能体**早就落地了**（§150 端到端验过、
            §176 补了"上交父级就地批准"）。它只是**没有单独列在这里**：
            它跑完记在**发起它的那一步**上（那一行写着步数与用量，被拦下的动作也挂在那一步上）。
            这里说清"为什么空"与"去哪看"，不给一个和自己代码相反的说明。
          */}
          <div className="wb-summary-empty" data-testid={`wb-summary-empty-${tab}`}>
            {tab === "browser"
              ? "浏览器操作会话会出现在这里（需要「操作浏览器」能力接入）"
              : "子智能体不单独列在这里：它跑完记在发起它的那一步上（工具留痕里写着步数与用量）；命令行侧可用 `ding agents` 查看内置专家。"}
          </div>
        </div>
      )}

      {/*
        ⚠️ 这两块原来是**写死的「暂无」**（2026-10-16，审计 P82）：
        输入区那条正渲染「启用了 3 个」的技能 chip，右栏同一屏却写「暂无」——
        同一个 store 的两个说法，用户只能怀疑其中一个在骗他。
        现在都从**已有**的地方推：技能取 `useLibraryStore` 的启用项（与 chip 同源），
        最近文件取这段会话的工具留痕里出现过的绝对路径（见 `summaryData.ts`）。
      */}
      <div className="wb-summary-section">
        <div className="wb-summary-title">技能</div>
        {enabledSkills.length ? (
          <div className="wb-summary-list" data-testid="wb-summary-skills">
            {enabledSkills.map((name) => (
              <div className="wb-summary-item" key={name}>
                <span className="wb-summary-item-name">{name}</span>
              </div>
            ))}
          </div>
        ) : (
          <div className="wb-summary-empty" data-testid="wb-summary-skills-empty">
            还没启用任何技能（在输入区的「技能」里挑）
          </div>
        )}
      </div>

      <div className="wb-summary-section">
        <div className="wb-summary-title">{SUMMARY_RECENT_FILES}</div>
        {recentFiles.length ? (
          <div className="wb-summary-list" data-testid="wb-summary-recent-files">
            {recentFiles.map((f) => (
              <div className="wb-summary-item" key={f.path} title={f.path}>
                <span className="wb-summary-item-name">{f.name}</span>
              </div>
            ))}
          </div>
        ) : (
          <div className="wb-summary-empty" data-testid="wb-summary-recent-files-empty">
            这段对话还没碰过文件（@ 一份资料，或让它读/写一个文件）
          </div>
        )}
      </div>
    </aside>
  );
}

/** 字节数说成人话。 */
