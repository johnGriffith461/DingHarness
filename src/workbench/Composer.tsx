/**
 * 从 `Workbench.tsx` 拆出来的（C6-1）。**纯挪位**：一个字没改，只加了 export 与 import。
 * 拆的理由原本记在 `docs/PLAN-C6-结构拆分.md`：那个文件 2188 行、14 个顶层组件，
 * ⚠️（该依据未入库、本机也找不到 —— 决策链断在这里，无法复核；以本文件里的断言与实现为准）
 * 改一处要读两千行 —— 于是「顺手加一行」变成默认做法。
 */

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Blocks, Check, ChevronDown, Paperclip, Plus, Sparkles, X } from "lucide-react";
import { useWorkbenchStore } from "./store";
import { draftKeyOf } from "./composerDraft";
import { useTransientNote } from "@/utils/transientNote";
import { applyPhrase, filterPhrases, phraseGroups, type Phrase } from "@shared/phrases";
import {
  applyMention,
  detectAtTrigger,
  sensitivePathReason,
  type AtTrigger,
  type Mention,
} from "@shared/mentions";
import type { MentionCandidateWire } from "@shared/projectWire";
import {
  detectSlashTrigger,
  filterSlashCommands,
  renderSlashHelp,
  resolveSlashCommand,
  type SlashCommand,
  type SlashTrigger,
} from "@shared/slashCommands";
import { SlashMenu } from "./SlashMenu";
import { readPlanMode, savePlanMode } from "./planMode";
import { COMPOSER_PLACEHOLDER } from "./copy";
import { resolveImportedMaterials } from "./materialImport";
import { UPLOAD_REASON_LABEL } from "@shared/upload";
import type { ChatPart, ShellBridge } from "@shared/ipc";
import { WORKSPACE_LABELS, addedNote, workspaceLabel } from "@shared/workspace";
import { fileContextBlock } from "./fileContext";
import { useLibraryStore } from "./libraryStore";
import { findItemIn } from "./libraryStore";
import { type ConfirmMode, type SessionSearchHit } from "@shared/ipc";
import { useDocStore } from "./docStore";
import { confirmOptionState, readConfirmMode, saveConfirmMode, subscribeConfirmMode } from "./confirmMode";
import { ComposerSendButton } from "./ComposerSendButton";
import SkillPanel from "./SkillPanel";
import { runFeedbackCommand } from "./feedbackExport";

import { CONFIRM_MODES } from "./uiUtil";
import { ComposerUsageLine } from "./ComposerUsageLine";
import { ModelChip } from "./ModelChip";
import { CONFIRM_HINT } from "./confirmHints";
import { useComposerDismiss } from "./useComposerDismiss";
import { EffortChip } from "./EffortChip";
import { sumUsage } from "@shared/cost";

/**
 * 这一轮还在跑时按发送要说的话（2026-10-16 审计 P46）。
 *
 * 导出成常量是为了**能被断言** —— 这句话与「跑着时那颗键是停止」是同一件事的两种说法，
 * 两处都写死字符串时最容易各自漂移（本仓反复清过的那类毛病）。
 */
export const P46_BUSY_NOTE = "这一轮还在跑：先点「停止」，或等它说完再发";

/**
 * 把导入失败的原因转成一句人话。
 *
 * ⚠️ 渲染侧看到的 `reason` 是 `string`（桥那边的类型比 `UploadFailReason` 宽），
 * 所以这里按"认识就说、不认识就兜底"，而不是硬转 —— 硬转会写出一个假的 `as`。
 *
 * @param reason 桥回来的原因
 * @returns 界面上要显示的那几个字
 */
function importReasonText(reason?: string): string {
  if (reason && reason in UPLOAD_REASON_LABEL) {
    return UPLOAD_REASON_LABEL[reason as keyof typeof UPLOAD_REASON_LABEL];
  }
  return "没能导入";
}

export function Composer({
  placeholder = COMPOSER_PLACEHOLDER,
  sendLabel,
  onSend,
}: {
  placeholder?: string;
  sendLabel?: string;
  /**
   * 这一句往哪儿送（§147）。
   *
   * 缺省是 `createTask`（新开一段对话）—— 首页/新任务就是如此。
   * **任务视图传的是 `sendInTask`**（在这段对话里接着说），
   * 这也是这个组件从"只能发起任务"变成"能续聊"的那个接缝。
   */
  onSend?: (text: string, options?: { material?: string; parts?: ChatPart[] }) => void;
}) {
  /** 正在跑一轮（流式）—— 决定发送键是「发送」还是「停止」（补完⑤）。 */
  const running = useWorkbenchStore((st) => Boolean(st.runningRequestId));
  const createTask = useWorkbenchStore((s) => s.createTask);
  const canvasOpen = useWorkbenchStore((s) => s.canvasOpen);
  const setCanvasOpen = useWorkbenchStore((s) => s.setCanvasOpen);
  const setView = useWorkbenchStore((s) => s.setView);
  const setPluginsIntent = useWorkbenchStore((s) => s.setPluginsIntent);
  /*
   * 当前任务（用量弹层要读它各步的 `usage`）。
   * ⚠️ 选的是**任务对象**本身：在 selector 里返回 `steps.map(...)` 之类的**新数组**
   * 会让每次渲染都被判成"变了"，很容易转成重渲染环。
   */
  const activeTask = useWorkbenchStore((s) => s.tasks.find((t) => t.id === s.activeTaskId));
  /*
   * ⚠️ 输入区的草稿**放在 store 里、按视图分开存**（2026-10-16，审计 P84）。
   *
   * 原来是组件内 `useState`，而 `Workbench` 按 view **整体换组件** ——
   * "在输入框里写着东西，按 Ctrl+N / 点左栏切个页"回来一看，**整段话没了**。
   * 现在这份文本跟着 store 走：换视图再回来，字还在。
   *
   * `draftKey` 由调用方给（首页一个 key、每段对话一个 key）——
   * 首页那份不该跑到对话那句输入框里去（两处用途不同：一个开新任务、一个在这段里接着说）。
   */
  const view = useWorkbenchStore((s) => s.view);
  const activeTaskId = useWorkbenchStore((s) => s.activeTaskId);
  const draftKey = draftKeyOf(view, activeTaskId);
  const text = useWorkbenchStore((s) => s.composerTexts[draftKey] ?? "");
  const setComposerText = useWorkbenchStore((s) => s.setComposerText);
  const setText = useCallback((next: string) => setComposerText(draftKey, next), [setComposerText, draftKey]);

  /**
   * **随这一轮交给 agent 的资料**（2026-10-14）。
   *
   * 输入区那条占位文案是本体原话「发消息或创建任务... / 使用技能 @ 添加资料」，
   * 而 `@` 在我们这儿只出了常用语（那句证据来自 coding 聊天）—— 界面承诺过、功能没做。
   * 这里就是补上的那一半：选文件 → 挂在输入区 → 发送时内容随请求过去。
   */
  const [material, setMaterial] = useState<Array<{ name: string; path: string }>>([]);
  /** 云盘里的文件（打开 @ 选单时读一次，点选即附着）。 */
  const [driveFiles, setDriveFiles] = useState<Array<{ name: string; path: string }>>([]);
  /**
   * 「从本机添加资料」的即时回执（成功几个、哪几个没进来以及为什么）。
   *
   * 失败**必须有回执**：选了 3 个文件只进来 1 个却什么都不说，用户只会以为坏了
   * （云盘那边有逐条状态面板，这里只有一行字，但**不能没有**）。
   */
  /* 提示条自己会消失（P91）：句柄由 hook 管 —— 后一条提示不许被前一条的定时器提前擦掉 */
  const [materialNote, showMaterialNote] = useTransientNote(4000);

  /** 读一次云盘清单（失败就当没有资料可加 —— 不该因为读不到清单让输入区报错）。 */
  const loadDriveFiles = async (): Promise<void> => {
    const shell = (globalThis as unknown as { shell?: ShellBridge }).shell;
    try {
      const list = await shell?.drive?.list?.();
      setDriveFiles((list ?? []).map((f: { name: string; path: string }) => ({ name: f.name, path: f.path })));
    } catch {
      setDriveFiles([]);
    }
  };

  /** 附着一份资料（已附着的忽略）。 */
  const attachMaterial = (file: { name: string; path: string }): void => {
    setMaterial((prev) => (prev.some((f) => f.path === file.path) ? prev : [...prev, file]));
    setAtTrigger(null);
  };

  /*
   * 「创作同款」这类按钮把一句话交过来（§159）：**取一次就清**。
   *
   * 只在这里 `take`，所以"谁负责清空"是明确的 ——
   * 否则那句草稿会一直躺在那儿，用户下次进首页又被填一遍。
   */
  const takeComposerDraft = useWorkbenchStore((s) => s.takeComposerDraft);
  useEffect(() => {
    const draft = takeComposerDraft();
    if (draft) setText(draft);
  }, [takeComposerDraft, setText]);

  /*
   * 输入区那几个 chip 的下拉，**共用一个"当前打开的是哪个"状态**。
   *
   * 原来是四个独立布尔（projectOpen / confirmOpen / skillOpen / pluginOpen）——
   * 开第二个时不会关掉第一个，两个浮层就**叠在一起**（用户报的）。
   *
   * 换成单值之后，"最多只有一个开着"是**结构上保证的**，不靠每处记得去关别人。
   * 以后再加 chip 也不会重犯这个问题。
   */
  /**
   * picker 的打开态（模型 / 档位 / 项目 / … **互斥**：同时只可能有一个）。
   *
   * ⚠️ 还要一个**token**：旧的 picker 关闭时会走「迟到」的回调，
   * 那种回调只能关掉**它自己那次打开的那个**，不许把已经接管的兄弟一起关掉
   * （ZCode 的 chat-model-select-menu 明确写了这条：迟到回调只清理自己）。
   */
  const popToken = useRef(0);
  /*
   * Ctrl+M / Ctrl+L：**只唤起模型菜单**（ZCode 的规矩：不按顺序循环切换 —— 换模型必须由用户在菜单里明确选）。
   * 焦点在输入框里也照样唤起（这条快捷键本来就是给键盘用户用的）。
   * Ctrl+L 是 B4 补的别名（多数编辑器/终端里它也是"找东西"的习惯键位）。
   */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const key = e.key.toLowerCase();
      if (!e.ctrlKey || (key !== "m" && key !== "l")) return;
      e.preventDefault();
      popToken.current += 1;
      setOpenPop((cur) => (cur === "model" ? null : "model"));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  /** 这一轮在跑吗（跑着的时候不许换模型 —— ZCode 的锁定语义）。 */
  const taskRunning = useWorkbenchStore((s) => (s.tasks.find((x) => x.id === s.activeTaskId)?.stage ?? "") === "running");
  const [openPop, setOpenPop] = useState<
    null | "project" | "confirm" | "skill" | "plugin" | "add" | "model" | "effort"
  >(null);
  /*
   * 工作区（2026-10-14）：用户授权给 agent 干活的目录。
   * 列表在**菜单打开时**才拉（它是主进程的磁盘状态，没必要一直挂着）。
   */
  const [workspaces, setWorkspaces] = useState<string[]>([]);
  useEffect(() => {
    if (openPop !== "add") return;
    const shell = (globalThis as unknown as { shell?: ShellBridge }).shell;
    void shell?.workspace
      ?.list?.()
      .then((r) => setWorkspaces(r?.dirs ?? []))
      .catch(() => setWorkspaces([]));
  }, [openPop]);
  const [projectId, setProjectId] = useState<string | null>(null);
  /*
   * 审批档位（§143）：
   * ① 初值从**持久化**读 —— 原来是写死「全部允许」的局部 state，
   *    用户选了「每步确认」、离开再回来就变回去了；
   * ② 选择时写回 —— 主进程的工具执行层要靠它做判定（随请求过界）。
   */
  /*
   * F-04：档位可能是**别处**改的（确认卡上的「本会话自动接受」）——
   * 原来这里只有 `useState` 初值，所以按钮点完 chip 还显示旧档位。
   * 现在订阅同一份存储：谁改都立刻反映到 chip 上。
   */
  const confirmMode = useSyncExternalStore(subscribeConfirmMode, readConfirmMode, readConfirmMode);
  const setConfirmMode = (mode: ConfirmMode): void => {
    saveConfirmMode(mode);
  };

  /* ⚠️ 2026-10-16：「模型 · 思考」那颗 chip 搬进 `ModelChip.tsx` 了 —— 它自己带着下拉与落盘，
     这里只剩一个挂载点（结构守卫也不允许这个文件再长，拆是对的）。 */

  /**
   * 切换某个下拉的开合：开的若是它自己就关掉，否则换成它。
   *
   * @param which 要切换的下拉
   */
  /** 关掉某个 picker：**只关它自己那次打开的**（见上面 token 的说明）。 */
  const closePop = (token: number): void => {
    if (popToken.current === token) setOpenPop(null);
  };

  const togglePop = (which: "project" | "confirm" | "skill" | "plugin" | "add" | "model" | "effort"): void =>
    setOpenPop((cur) => (cur === which ? null : which));
  /* 2026-10-22 主人：点对话框应把插件/模型那些弹层收掉（判据与两次弯路见该文件头） */
  useComposerDismiss(openPop !== null, () => setOpenPop(null));

  const installed = useLibraryStore((s) => s.lib.installed);
  const enabled = useLibraryStore((s) => s.lib.enabled);
  const enable = useLibraryStore((s) => s.enable);
  const lib = useLibraryStore((s) => s.lib);
  /** 已装项里按类型分开 —— 「插件」这个 chip 只看插件。 */
  const installedPlugins = installed.filter((id) => findItemIn(lib, id)?.type === "plugin");
  const enabledPlugins = enabled.filter((id) => findItemIn(lib, id)?.type === "plugin");

  /** 当前选中的项目名（没选则为 null，chip 上回落到"项目"）。 */
  const projectName = lib.projects.find((p) => p.id === projectId)?.name ?? null;

  const submit = async (): Promise<void> => {
    const value = text.trim();
    if (!value) return;
    /*
     * ⚠️ **这一轮还在跑就不许再发**（2026-10-16 审计 P46）。
     *
     * `Enter` 那条路原来只看 `shiftKey`、不看 `running` —— 于是跑着的时候连按两下回车，
     * 就会往同一段对话里并发起两轮（步骤 id 按序号生成会撞、会话日志互插、第二轮的历史里
     * 没有第一轮的回答）。这里**如实说一句**再返回，而不是静默吞掉：
     * 静默吞掉的话用户看到的是"按了没反应"，只会再按一次。
     *
     * 界面上此刻那颗键就是「停止」，所以这条提示只是把"为什么发不出去"说清。
     * store 侧还有一道同样的守卫（`sendInTask`）—— 挡住绕过界面的那条路。
     */
    if (running) {
      showMaterialNote(P46_BUSY_NOTE);
      return;
    }
    /*
     * B2：整行是斜杠命令时**不发给模型**。未知命令提示 `/help` 并保留原文。
     */
    if (detectSlashTrigger(value, value.length)) {
      const command = resolveSlashCommand(value);
      if (!command) {
        showMaterialNote("没有这个命令，试试 /help");
        return;
      }
      await runSlash(command);
      return;
    }
    setText("");
    /*
     * 资料在**发送这一刻**读成文本（不是附着那一刻）：
     * 用户可能先把文件挂上、过一会儿才发，中间还改过文件 —— 发的是**发的时候**那份内容。
     * 读不到就如实写"读不到"（`fileContextBlock` 负责），绝不编。
     */
    let block = "";
    const shell = (globalThis as unknown as { shell?: ShellBridge }).shell;
    const reads: Array<{ path: string; text: string | null }> = [];
    if (material.length) {
      for (const file of material) {
        const text = await Promise.resolve(shell?.drive?.read?.(file.path)).catch(() => null);
        reads.push({ path: file.path, text: typeof text === "string" ? text : null });
      }
    }
    /*
     * B1：正文里的 `@` 引用在**发送这一刻**展开成内容。
     * 只展开真正选中过、且文字还在正文里的那些（用户删掉那段字就不带了）。
     */
    for (const mention of mentionChips) {
      if (!value.includes(mention.token)) continue;
      if (mention.kind === "file" && mention.path) {
        const got = await Promise.resolve(shell?.project?.readFile?.(mention.path)).catch(() => null);
        reads.push({ path: mention.label, text: got?.ok ? got.text : null });
      } else if (mention.kind === "dir" && mention.path) {
        const listed = await Promise.resolve(shell?.project?.listDir?.(mention.path)).catch(() => null);
        const listing = Array.isArray(listed) && listed.length
          ? listed.map((e) => `- ${e.label}${e.kind === "dir" ? "/" : ""}`).join("\n")
          : null;
        reads.push({ path: `${mention.label}/`, text: listing });
      } else if (mention.kind === "session") {
        reads.push({
          path: `[会话] ${mention.label}`,
          text: `引用了历史会话「${mention.label}」（id ${mention.sessionId ?? ""}）。需要其中细节时向用户确认要看哪一段。`,
        });
      } else if (mention.kind === "skill") {
        reads.push({ path: `[技能] ${mention.label}`, text: `按技能「${mention.label}」的方法执行本次任务。` });
      }
    }
    if (reads.length) block = fileContextBlock(reads);
    /*
     * B3：附件转成这一轮的多模态片段；落盘是**尽力而为**（记路径与 sha256 用），
     * 落盘失败不影响发送 —— 内容已经在 parts 里。
     */
    const parts: ChatPart[] = attachments.map((a) =>
      a.kind === "image"
        ? { type: "image", data: a.data, mediaType: a.mediaType }
        : { type: "file", data: a.data, mediaType: a.mediaType, filename: a.name },
    );
    /*
     * G2：落盘交给 store（那里才拿得到**这次真正写入的任务 id**）。
     * 原来是在这里 `void save(...)` 到 `activeTaskId ?? "draft"`：
     * 新任务会落到 draft 目录、重启后被会话目录校验拒掉 —— 图就"消失"了。
     */
    const attachmentDrafts = attachments.map((a) => ({ name: a.name, mediaType: a.mediaType, data: a.data }));
    setAttachments([]);
    setMaterial([]);
    setMentionChips([]);
    const options =
      block || parts.length || attachmentDrafts.length
        ? {
            ...(block ? { material: block } : {}),
            ...(parts.length ? { parts } : {}),
            ...(attachmentDrafts.length ? { attachmentDrafts } : {}),
          }
        : undefined;
    // 传了 onSend 就按它的（任务视图 = 在这段对话里接着说）；没传就是新开一段
    if (onSend) onSend(value, options);
    else void createTask(value, options);
  };

  const enabledNames = enabled.map((id) => findItemIn(lib, id)?.name).filter((x): x is string => Boolean(x));

  /*
   * `@` 常用语（§161）：证据里那句是
   * `coding_chat_mode_new_placeholder` = 输入"@"唤起常用语，或粘贴代码快速提问。
   *
   * 触发判定在纯逻辑里（`detectAtTrigger`）—— 尤其是**句中的 @ 不触发**（邮箱那种），
   * 这条最容易写错，单独测了。
   */
  const [atTrigger, setAtTrigger] = useState<AtTrigger | null>(null);
  /** B2：`/` 命令触发（与 `@` 互斥：一行开头是 `/` 就不再当引用词）。 */
  const [slashTrigger, setSlashTrigger] = useState<SlashTrigger | null>(null);
  const [slashIndex, setSlashIndex] = useState(0);
  /** C1：计划模式（只读工具；持久化在 localStorage）。 */
  const [planOn, setPlanOn] = useState(readPlanMode());
  const togglePlan = (): void => {
    const next = !readPlanMode();
    savePlanMode(next);
    setPlanOn(next);
    /* 2026-10-22：进入时上方已有 `wb-plan-banner` 说同一句话，不再叠一条提示（退出才说） */
    if (!next) showMaterialNote("已退出计划模式");
  };
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  /**
   * B1：`@` 菜单的五类候选。文件/目录由主进程读盘（只在工作区内），
   * 会话走已有的 `session.search`（FTS + LIKE），技能走 `skills.list`，
   * 动作就是原来的常用语。
   */
  const [fileHits, setFileHits] = useState<MentionCandidateWire[]>([]);
  const [sessionHits, setSessionHits] = useState<SessionSearchHit[]>([]);
  const [skillHits, setSkillHits] = useState<Array<{ name: string; description?: string }>>([]);
  /** 这一轮真正选中过的引用（带绝对路径/会话 id），提交时按它展开。 */
  type MentionChip = {
    token: string;
    kind: Mention["kind"];
    label: string;
    path?: string;
    sessionId?: string;
    skillName?: string;
  };
  const [mentionChips, setMentionChips] = useState<MentionChip[]>([]);

  /**
   * B3：图片 / PDF 附件（粘贴、拖拽、`+` 三路都进这里）。
   * `data` 是 base64，提交时转成 `ChatPart`；发送前还会尽力落盘（记路径/sha256）。
   */
  type AttachmentDraft = { id: string; name: string; mediaType: string; data: string; kind: "image" | "file" };
  const [attachments, setAttachments] = useState<AttachmentDraft[]>([]);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const addAttachments = async (files: File[]): Promise<void> => {
    const accepted: AttachmentDraft[] = [];
    for (const file of files) {
      const mediaType = file.type || "application/octet-stream";
      const kind: "image" | "file" | null = mediaType.startsWith("image/")
        ? "image"
        : mediaType === "application/pdf"
          ? "file"
          : null;
      if (!kind) {
        showMaterialNote(`只支持图片与 PDF：${file.name}`);
        continue;
      }
      if (file.size > 25 * 1024 * 1024) {
        showMaterialNote(`${file.name} 超过 25 MiB，没有加进来`);
        continue;
      }
      const data = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
          const result = String(reader.result ?? "");
          resolve(result.includes(",") ? result.slice(result.indexOf(",") + 1) : result);
        };
        reader.onerror = () => reject(reader.error ?? new Error("读文件失败"));
        reader.readAsDataURL(file);
      }).catch(() => "");
      if (!data) {
        showMaterialNote(`读不到 ${file.name}`);
        continue;
      }
      accepted.push({ id: `${file.name}-${file.lastModified}-${Math.random().toString(36).slice(2, 8)}`, name: file.name, mediaType, data, kind });
    }
    if (accepted.length) setAttachments((prev) => [...prev, ...accepted]);
  };

  /** 拉候选（150ms 防抖由下面的 effect 负责）。 */
  const loadMentionHits = async (query: string): Promise<void> => {
    const shell = (globalThis as unknown as { shell?: ShellBridge }).shell;
    try {
      const files = await Promise.resolve(shell?.project?.mentions?.(query)).catch(() => []);
      setFileHits(Array.isArray(files) ? files : []);
    } catch {
      setFileHits([]);
    }
    try {
      const hits = query.trim() ? await Promise.resolve(shell?.session?.search?.(query)).catch(() => []) : [];
      setSessionHits(Array.isArray(hits) ? hits.slice(0, 6) : []);
    } catch {
      setSessionHits([]);
    }
    try {
      const listed = await Promise.resolve(shell?.skills?.list?.()).catch(() => null);
      const q = query.trim().toLowerCase();
      const skills = (listed?.skills ?? [])
        .filter((s: { name: string; description?: string }) => !q || s.name.toLowerCase().includes(q) || String(s.description ?? "").toLowerCase().includes(q))
        .slice(0, 6);
      setSkillHits(skills);
    } catch {
      setSkillHits([]);
    }
  };

  useEffect(() => {
    if (!atTrigger) return;
    const timer = setTimeout(() => void loadMentionHits(atTrigger.query), 150);
    return () => clearTimeout(timer);
  }, [atTrigger?.query]);

  /** 光标一动就重算（输入、点、方向键都算）。 */
  const syncTrigger = (el: HTMLTextAreaElement): void => {
    const caret = el.selectionStart ?? el.value.length;
    const slash = detectSlashTrigger(el.value, caret);
    setSlashTrigger(slash);
    if (slash) {
      setAtTrigger(null);
      setSlashIndex(0);
      return;
    }
    const next = detectAtTrigger(el.value, caret);
    setAtTrigger(next);
    /* 第一次唤起选单时把云盘清单读进来（点选即附着，不用再点一次"添加资料"）。 */
    if (next && driveFiles.length === 0) void loadDriveFiles();
  };

  const matched = atTrigger ? filterPhrases(atTrigger.query) : [];
  const slashMatches = slashTrigger ? filterSlashCommands(slashTrigger.query) : [];
  const mentionFiles = fileHits.filter((f) => f.kind === "file");
  const mentionDirs = fileHits.filter((f) => f.kind === "dir");

  /** 选中一条引用：替换 `@查询词`，记下展开用的绝对路径，光标落到末尾。 */
  const pickMention = (mention: Omit<MentionChip, "token">, kind: Mention["kind"]): void => {
    if (!atTrigger) return;
    /*
     * 正文里插**相对路径**（`@foo.ts`），chip 里留**绝对路径**（发送时读盘用）。
     * 直接把绝对路径写进正文会让输入框一行被 `C:\...` 占满，而且换机器就失效。
     */
    const next = applyMention(text, atTrigger, {
      kind,
      label: mention.label,
      path: mention.label,
      ...(mention.sessionId ? { sessionId: mention.sessionId } : {}),
      ...(mention.skillName ? { skillName: mention.skillName } : {}),
    });
    setText(next.text);
    setMentionChips((prev) => [
      ...prev.filter((c) => c.token !== next.token),
      { ...mention, kind, token: next.token },
    ]);
    setAtTrigger(null);
    requestAnimationFrame(() => {
      const el = inputRef.current;
      if (el) {
        el.focus();
        el.setSelectionRange(next.caret, next.caret);
      }
    });
  };

  /**
   * `/init`：按探测到的环境生成 `AGENTS.md` 草稿，**先预览再写**。
   * 取消预览就一个字节都不写。
   */
  const initAgents = async (): Promise<void> => {
    const shell = (globalThis as unknown as { shell?: ShellBridge }).shell;
    const got = await Promise.resolve(shell?.project?.context?.()).catch(() => null);
    if (!got) {
      showMaterialNote("读不到项目上下文，先检查工作区是否已授权");
      return;
    }
    const listed = await Promise.resolve(shell?.project?.listDir?.(".")).catch(() => null);
    const dirs = (Array.isArray(listed) ? listed : [])
      .filter((e) => e.kind === "dir")
      .map((e) => e.label)
      .slice(0, 20);
    const draft = [
      "# AGENTS.md",
      "",
      "## 项目概览",
      "",
      `- 工作目录：${got.context.cwd}`,
      `- 包管理器：${got.context.packageManager ?? "未探测到"}`,
      `- 测试命令：${got.context.testCommand ?? "未探测到"}`,
      "",
      "## 目录结构（顶层）",
      "",
      ...(dirs.length ? dirs.map((d) => `- ${d}/`) : ["- （未读到顶层目录）"]),
      "",
      "## 工作约定",
      "",
      "- 改代码前先读相关文件与测试；改完跑测试或构建，拿 pass/fail 说话。",
      "- 不要注释掉失败测试、不要吞异常、不要伪造命令输出。",
      "",
    ].join("\n");
    const ok = typeof window !== "undefined" && typeof window.confirm === "function"
      ? window.confirm(`将写入 AGENTS.md，预览如下：\n\n${draft}`)
      : false;
    if (!ok) {
      showMaterialNote("已取消，没有写文件");
      return;
    }
    const wrote = await Promise.resolve(shell?.project?.writeAgents?.(draft)).catch(() => null);
    showMaterialNote(wrote?.ok ? `已写入 ${wrote.path}` : `写入失败：${wrote?.error ?? "未知原因"}`);
  };

  /** `/export`：把当前对话导出成 Markdown（纯前端，不新增后端）。 */
  const exportSession = (): void => {
    const task = useWorkbenchStore.getState().tasks.find((t) => t.id === useWorkbenchStore.getState().activeTaskId);
    if (!task) {
      showMaterialNote("没有打开的对话");
      return;
    }
    const md = [
      `# ${task.title}`,
      "",
      ...task.steps.map((s) => `## ${s.role === "user" ? "用户" : "助手"}\n\n${s.text}\n`),
    ].join("\n");
    const url = URL.createObjectURL(new Blob([md], { type: "text/markdown;charset=utf-8" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `${task.title || "session"}.md`;
    a.click();
    URL.revokeObjectURL(url);
    showMaterialNote(`已导出 ${a.download}`);
  };

  /** 执行一条斜杠命令（映射已有动作，不新增后端）。 */
  const runSlash = async (command: SlashCommand): Promise<void> => {
    setSlashTrigger(null);
    const store = useWorkbenchStore.getState();
    switch (command.name) {
      case "new":
        setText("");
        store.setView("home");
        showMaterialNote("已开启新会话");
        return;
      case "model":
        setText("");
        setOpenPop("model");
        return;
      case "plan":
        setText("");
        togglePlan();
        return;
      case "compact": {
        const result = await store.compactActive();
        showMaterialNote(result.ok ? `已压缩 ${result.older} 条更早的对话` : (result.error ?? "压缩失败"));
        return;
      }
      case "context":
      case "cost":
        setText("");
        store.setView("usage");
        return;
      case "init":
        setText("");
        await initAgents();
        return;
      case "export":
        setText("");
        exportSession();
        return;
      case "permissions":
        setText("");
        store.setView("permissions");
        return;
      case "map": {
        setText("");
        const shell = (globalThis as unknown as { shell?: ShellBridge }).shell;
        const map = await Promise.resolve(shell?.project?.repoMap?.({ maxTokens: 1024 })).catch(() => null);
        showMaterialNote(
          map?.text
            ? `仓库地图：${map.files} 个文件 / ${map.symbols} 个符号（${map.ms}ms）—— ${map.text.split("\n").slice(0, 3).join(" · ")}`
            : "这个工作区还没有可索引的 TS/JS 文件",
        );
        return;
      }
      case "help":
        setText("");
        showMaterialNote(renderSlashHelp().replace(/\n+/g, "  "));
        return;
    }
  };

  /** 选中一条常用语（动作分组）：插入它的话术正文，不产生引用附件。 */
  const pickPhrase = (phrase: Phrase): void => {
    if (!atTrigger) return;
    const next = applyPhrase(text, atTrigger, phrase);
    setText(next.text);
    setAtTrigger(null);
    // 光标要等这一帧渲染完再落（否则会被 value 覆盖回末尾）
    requestAnimationFrame(() => {
      const el = inputRef.current;
      if (el) {
        el.focus();
        el.setSelectionRange(next.caret, next.caret);
      }
    });
  };

  return (
    /*
     * 两层（2026-10-22 主人：「本段对话…位置还得往下，在输入框外的下面」）：
     * 外层 shell 不带边框与底色，只负责列宽；内层 `.wb-composer` 才是那张输入卡片。
     * 用量那行字因此落在**卡片外面**、卡片下方。
     */
    <div className="wb-composer-shell" data-testid="wb-composer-shell">
      <div
        className="wb-composer"
        /* C-01：首页首屏只留输入框/推荐卡/模型/档位；其余 chip 收进「更多」。 */
        data-compact-home={view === "home" ? "true" : undefined}
        data-testid="wb-composer"
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          const files = Array.from(e.dataTransfer?.files ?? []);
          if (files.length) void addAttachments(files);
        }}
      >
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*,application/pdf"
        multiple
        style={{ display: "none" }}
        data-testid="wb-attach-input"
        onChange={(e) => {
          void addAttachments(Array.from(e.target.files ?? []));
          e.target.value = "";
        }}
      />
      {slashTrigger ? (
        <SlashMenu commands={slashMatches} selected={slashIndex} onPick={(command) => void runSlash(command)} />
      ) : null}
      {atTrigger ? (
        /*
         * ⚠️ `onMouseDown` 里 `preventDefault()` 是必须的：
         * 不然点选单会先让输入框 `blur` → 我的 `onBlur` 把 `atTrigger` 清成 null →
         * 紧接着的 `onClick` 拿到的是 null，于是**菜单关了但什么都没替换**。
         * （第一版就是这么错的：点了没反应，看着像"点不动"。）
         */
        <div
          className="wb-phrase-menu"
          data-testid="wb-phrase-menu"
          onMouseDown={(e) => e.preventDefault()}
        >
          <div className="wb-phrase-head">引用与动作</div>
          {/*
            资料（2026-10-14）：占位文案承诺的「@ 添加资料」。
            与常用语**同在一个选单里**，但两栏分开 —— 本体首页那条文案说的是资料，
            coding 聊天那条说的是常用语，我们两个能力都有，就不该为了"照哪一条"删掉另一个。
          */}
          {driveFiles.length > 0 ? (
            <div>
              <div className="wb-phrase-group" data-testid="wb-material-group">
                资料（点一下加进这轮）
              </div>
              {driveFiles
                .filter((f) => !atTrigger?.query || f.name.toLowerCase().includes(atTrigger.query.toLowerCase()))
                .slice(0, 6)
                .map((f) => (
                  <button
                    key={f.path}
                    className="wb-phrase-item"
                    data-testid={`wb-material-${f.name}`}
                    onClick={() => attachMaterial(f)}
                  >
                    {f.name}
                  </button>
                ))}
            </div>
          ) : null}
          {mentionDirs.length > 0 ? (
            <div>
              <div className="wb-phrase-group" data-testid="wb-mention-group-dir">
                目录
              </div>
              {mentionDirs.map((d) => (
                <button
                  key={d.path}
                  className="wb-phrase-item"
                  data-testid={`wb-mention-dir-${d.label}`}
                  onClick={() => pickMention({ kind: "dir", label: d.label, path: d.path }, "dir")}
                >
                  {d.label}/
                </button>
              ))}
            </div>
          ) : null}
          {mentionFiles.length > 0 ? (
            <div>
              <div className="wb-phrase-group" data-testid="wb-mention-group-file">
                文件
              </div>
              {mentionFiles.map((f) => (
                <button
                  key={f.path}
                  className="wb-phrase-item"
                  data-testid={`wb-mention-file-${f.label}`}
                  onClick={() => pickMention({ kind: "file", label: f.label, path: f.path }, "file")}
                  title={sensitivePathReason(f.path) ?? f.path}
                >
                  {f.label}
                </button>
              ))}
            </div>
          ) : null}
          {sessionHits.length > 0 ? (
            <div>
              <div className="wb-phrase-group" data-testid="wb-mention-group-session">
                会话
              </div>
              {sessionHits.map((s) => (
                <button
                  key={s.sessionId}
                  className="wb-phrase-item"
                  data-testid={`wb-mention-session-${s.sessionId}`}
                  onClick={() => pickMention({ kind: "session", label: s.title || s.sessionId, sessionId: s.sessionId }, "session")}
                >
                  {s.title || s.sessionId}
                </button>
              ))}
            </div>
          ) : null}
          {skillHits.length > 0 ? (
            <div>
              <div className="wb-phrase-group" data-testid="wb-mention-group-skill">
                技能
              </div>
              {skillHits.map((s) => (
                <button
                  key={s.name}
                  className="wb-phrase-item"
                  data-testid={`wb-mention-skill-${s.name}`}
                  onClick={() => pickMention({ kind: "skill", label: s.name, skillName: s.name }, "skill")}
                >
                  {s.name}
                </button>
              ))}
            </div>
          ) : null}
          {matched.length === 0 && mentionDirs.length + mentionFiles.length + sessionHits.length + skillHits.length === 0 ? (
            <p className="wb-phrase-empty" data-testid="wb-phrase-empty">
              没有匹配的文件、会话、技能或动作
            </p>
          ) : matched.length === 0 ? null : (
            phraseGroups().map((group) => {
              const items = matched.filter((p) => p.group === group);
              if (!items.length) return null;
              return (
                <div key={group}>
                  <div className="wb-phrase-group">{group}</div>
                  {items.map((p) => (
                    <button
                      key={p.id}
                      className="wb-phrase-item"
                      data-testid={`wb-phrase-${p.id}`}
                      onClick={() => pickPhrase(p)}
                    >
                      {p.title}
                    </button>
                  ))}
                </div>
              );
            })
          )}
        </div>
      ) : null}
      {materialNote ? (
        <div className="wb-material-note" data-testid="wb-material-note" role="status">
          {materialNote}
        </div>
      ) : null}
      {material.length > 0 ? (
        <div className="wb-material-chips" data-testid="wb-material-chips">
          {material.map((f) => (
            <span key={f.path} className="wb-material-chip" data-testid={`wb-material-chip-${f.name}`}>
              {f.name}
              <button
                className="wb-material-x"
                title="移出这轮"
                onClick={() => setMaterial((prev) => prev.filter((x) => x.path !== f.path))}
              >
                ×
              </button>
            </span>
          ))}
        </div>
      ) : null}
      {mentionChips.length > 0 ? (
        <div className="wb-material-chips" data-testid="wb-mention-chips">
          {mentionChips.map((m) => (
            <span key={m.token} className="wb-material-chip" data-testid={`wb-mention-chip-${m.label}`}>
              {m.kind === "session" ? "会话：" : m.kind === "skill" ? "技能：" : ""}
              {m.label}
              <button
                className="wb-material-x"
                title="移除这个引用"
                onClick={() => {
                  const next = text.replace(m.token, "").replace(/\s{2,}/g, " ").trim();
                  setText(next);
                  setMentionChips((prev) => prev.filter((x) => x.token !== m.token));
                }}
              >
                ×
              </button>
            </span>
          ))}
        </div>
      ) : null}
      {planOn ? (
        <div className="wb-material-note" data-testid="wb-plan-banner" role="status">
          计划模式：只读工具 · 先给计划，确认后再执行
          {activeTask?.steps.some((s) => s.role === "assistant") ? (
            <button
              className="wb-setpage-btn"
              data-testid="wb-plan-execute"
              onClick={() => {
                const store = useWorkbenchStore.getState();
                const id = store.activeTaskId;
                if (!id) return;
                savePlanMode(false);
                setPlanOn(false);
                /*
                 * G1：有正式的计划草稿就走"落盘 + 状态机"那条路；
                 * 旧任务（模型已经答过、但还没有 planState）保持原来的直接发一句。
                 */
                const task = store.tasks.find((t) => t.id === id);
                if (task?.planState === "awaiting_approval") {
                  void store.approvePlan(id);
                  return;
                }
                void store.sendInTask(id, "按上面的计划开始执行");
              }}
            >
              开始执行
            </button>
          ) : null}
        </div>
      ) : null}
      {attachments.length > 0 ? (
        <div className="wb-material-chips" data-testid="wb-attachment-chips">
          {attachments.map((a) => (
            <span key={a.id} className="wb-material-chip" data-testid={`wb-attachment-chip-${a.name}`}>
              {a.kind === "image" ? "图片：" : "PDF："}
              {a.name}
              <button
                className="wb-material-x"
                title="移除附件"
                onClick={() => setAttachments((prev) => prev.filter((x) => x.id !== a.id))}
              >
                ×
              </button>
            </span>
          ))}
        </div>
      ) : null}
      <textarea
        ref={inputRef}
        className="wb-composer-input"
        data-testid="wb-composer-input"
        rows={2}
        placeholder={placeholder}
        value={text}
        onChange={(e) => {
          const next = e.target.value;
          setText(next);
          /* 文字里删掉某个引用 → 它的附件也一起失效（ZCode 同款） */
          setMentionChips((prev) => prev.filter((c) => next.includes(c.token)));
          syncTrigger(e.target);
        }}
        onKeyUp={(e) => {
          /*
           * ⚠️ Esc 之后**不能**再同步一次：`keyup` 晚于 `keydown`，
           * 而按 Esc 时正文没变（还是 `@xxx`），重算一遍触发条件就又成立 ——
           * 于是"按 Esc 收起"立刻被自己重新打开。
           */
          if (e.key === "Escape") return;
          syncTrigger(e.currentTarget);
        }}
        onClick={(e) => syncTrigger(e.currentTarget)}
        onPaste={(e) => {
          /* B3：粘贴截图 / 复制的 PDF → 直接进附件 chip（纯文本粘贴走默认） */
          const files = Array.from(e.clipboardData?.files ?? []);
          if (files.length) {
            e.preventDefault();
            void addAttachments(files);
          }
        }}
        onBlur={() => {
          setAtTrigger(null);
          setSlashTrigger(null);
        }}
        onKeyDown={(e) => {
          /* C1：Shift+Tab 切换计划模式（只读工具面；不是插一段话） */
          if (e.key === "Tab" && e.shiftKey) {
            e.preventDefault();
            togglePlan();
            return;
          }
          // 命令菜单：Esc 收起、↑↓ 选择、Enter 执行（别顺手发出去）
          if (slashTrigger) {
            if (e.key === "Escape") {
              e.preventDefault();
              setSlashTrigger(null);
              return;
            }
            if (e.key === "ArrowDown" || e.key === "ArrowUp") {
              e.preventDefault();
              const delta = e.key === "ArrowDown" ? 1 : -1;
              const total = slashMatches.length;
              if (total) setSlashIndex((cur) => (cur + delta + total) % total);
              return;
            }
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              const pick = slashMatches[slashIndex] ?? slashMatches[0];
              if (pick) void runSlash(pick);
              else showMaterialNote("没有这个命令，试试 /help");
              return;
            }
          }
          // 引用菜单：Esc 收起、Enter 选第一条
          if (atTrigger) {
            if (e.key === "Escape") {
              e.preventDefault();
              setAtTrigger(null);
              return;
            }
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              const dir = mentionDirs[0];
              const file = mentionFiles[0];
              const session = sessionHits[0];
              const skill = skillHits[0];
              if (dir) pickMention({ kind: "dir", label: dir.label, path: dir.path }, "dir");
              else if (file) pickMention({ kind: "file", label: file.label, path: file.path }, "file");
              else if (session) pickMention({ kind: "session", label: session.title || session.sessionId, sessionId: session.sessionId }, "session");
              else if (skill) pickMention({ kind: "skill", label: skill.name, skillName: skill.name }, "skill");
              else if (matched.length) pickPhrase(matched[0] as Phrase);
              return;
            }
          }
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            submit();
          }
        }}
      />
      <div className="wb-composer-bar">
        {/*
          输入区的 `+`：原来是个**禁用按钮**（"本机版还没接原生文件对话框"）。
          本体这个位置里有「新建文档」（`doc_create` / `create_document_button_title`），
          所以这里做个真菜单 —— 至少「新建文档」是真的能用的。
        */}
        <div className="wb-chip-wrap">
          <button
            className="wb-icon"
            aria-label="更多" title="更多"
            data-testid="wb-composer-add"
            onClick={() => togglePop("add")}
          >
            <Plus size={16} />
          </button>
          {openPop === "add" ? (
            <div className="wb-chip-pop" data-testid="wb-add-pop" onMouseLeave={() => setOpenPop(null)}>
              {/* B3：图片 / PDF（与粘贴、拖拽同一入口） */}
              <button
                className="wb-chip-option"
                data-testid="wb-add-attachment"
                onClick={() => {
                  setOpenPop(null);
                  fileInputRef.current?.click();
                }}
              >
                图片 / PDF
              </button>
              <button
                className="wb-chip-option"
                data-testid="wb-add-doc"
                onClick={() => {
                  setOpenPop(null);
                  void useDocStore.getState().create().then(() => useWorkbenchStore.getState().setView("doc"));
                }}
              >
                新建文档
              </button>
              <button
                className="wb-chip-option"
                data-testid="wb-add-reader"
                onClick={() => {
                  setOpenPop(null);
                  useWorkbenchStore.getState().setView("reader");
                }}
              >
                进入 AI 阅读
              </button>
              <button
                className="wb-chip-option"
                data-testid="wb-add-agent"
                onClick={() => {
                  setOpenPop(null);
                  useWorkbenchStore.getState().setView("agent");
                }}
              >
                创建 AI 智能体
              </button>
              <button
                className="wb-chip-option"
                data-testid="wb-add-coding"
                onClick={() => {
                  setOpenPop(null);
                  useWorkbenchStore.getState().setView("coding");
                }}
              >
                创作广场
              </button>
              {/*
                2026-10-22 主人：「计划 这个东西 放到 对话框的加号里面」——
                从工具条挪进「＋」菜单。它是个**开关**，所以带勾选态。
              */}
              <button
                className={`wb-chip-option${planOn ? " is-on" : ""}`}
                data-testid="wb-add-plan"
                role="menuitemcheckbox"
                aria-checked={planOn}
                title={planOn ? "计划模式：只读工具；再点一次退出" : "进入计划模式（只读工具）"}
                onClick={() => {
                  togglePlan();
                  setOpenPop(null);
                }}
              >
                <Blocks size={13} /> 计划模式{planOn ? <Check size={13} /> : null}
              </button>
              <button
                className="wb-chip-option"
                data-testid="wb-add-image"
                onClick={() => {
                  setOpenPop(null);
                  useWorkbenchStore.getState().setView("image");
                }}
              >
                图片生成
              </button>
              <button
                className="wb-chip-option"
                data-testid="wb-add-video"
                onClick={() => {
                  setOpenPop(null);
                  useWorkbenchStore.getState().setView("video");
                }}
              >
                视频生成
              </button>
              {/*
                「选本地文件当资料」（2026-10-14 接上）。
                原来这里写的是"本机版还没接原生文件对话框" —— 而 `drive:import` 早就有
                （云盘页的「上传」走的就是它：`dialog.showOpenDialog` → 拷进云盘目录）。
                这里复用它：选中之后文件进云盘，然后**直接挂成这一轮的资料** ——
                于是 agent 既能读到内容（内容随请求过去），云盘里也留了一份。
              */}
              <button
                className="wb-chip-option"
                data-testid="wb-add-file"
                onClick={() => {
                  setOpenPop(null);
                  void (async () => {
                    const shell = (globalThis as unknown as { shell?: ShellBridge }).shell;
                    const got = await shell?.drive?.importFiles?.();
                    const items = got?.items ?? [];
                    if (!items.length) return;
                    /*
                     * 解析收在 `materialImport.ts`（纯函数、有单测）：
                     * 导入 IPC 只回名字与成败，路径要从云盘清单里认回来。
                     */
                    const list = (await shell?.drive?.list?.()) ?? [];
                    const { picked, rejected, unmatched } = resolveImportedMaterials(items, list);
                    if (picked.length) {
                      setMaterial((prev) => {
                        const seen = new Set(prev.map((f) => f.path));
                        return [...prev, ...picked.filter((f) => !seen.has(f.path))];
                      });
                    }
                    const parts: string[] = [];
                    if (rejected.length) {
                      parts.push(
                        `${rejected.length} 个没进来：${rejected
                          .map((r) => `${r.name}（${importReasonText(r.reason)}）`)
                          .join("、")}`,
                      );
                    }
                    if (unmatched.length) parts.push(`${unmatched.length} 个导入后在云盘里没找到：${unmatched.join("、")}`);
                    showMaterialNote(parts.length ? parts.join("；") : picked.length ? `已添加 ${picked.length} 个文件` : "");
                  })();
                }}
              >
                从本机添加资料
              </button>
              {/*
                「授权文件夹给 agent」（2026-10-14）。
                这是 agent 真能干活的前提：不授权的话它只能在自己的云盘里活动，
                而那里放的是**副本** —— "帮我整理这个文件夹"根本无从谈起。
                ⚠️ 授权走**系统目录选择器**（主进程那边不接受渲染层传路径），
                所以这里只发一个"弹一下"的请求。
              */}
              <div className="wb-chip-title" data-testid="wb-workspace-group">
                工作区（让 agent 在这些目录里干活）
              </div>
              {workspaces.length === 0 ? (
                <div className="wb-chip-empty" data-testid="wb-workspace-empty">
                  {WORKSPACE_LABELS.empty}
                </div>
              ) : (
                workspaces.map((dir) => (
                  <div className="wb-chip-row" key={dir} data-testid={`wb-workspace-${workspaceLabel(dir)}`}>
                    <span className="wb-chip-row-name" title={dir}>
                      {workspaceLabel(dir)}
                    </span>
                    <button
                      className="wb-chip-row-x"
                      type="button"
                      title={WORKSPACE_LABELS.remove}
                      aria-label={`${WORKSPACE_LABELS.remove} ${workspaceLabel(dir)}`}
                      data-testid={`wb-workspace-remove-${workspaceLabel(dir)}`}
                      onClick={() => {
                        const shell = (globalThis as unknown as { shell?: ShellBridge }).shell;
                        void shell?.workspace?.remove?.(dir).then((r) => {
                          setWorkspaces(r?.dirs ?? []);
                          showMaterialNote(WORKSPACE_LABELS.removedNote);
                        });
                      }}
                    >
                      ×
                    </button>
                  </div>
                ))
              )}
              <button
                className="wb-chip-option"
                data-testid="wb-add-workspace"
                onClick={() => {
                  const shell = (globalThis as unknown as { shell?: ShellBridge }).shell;
                  void (async () => {
                    const got = await shell?.workspace?.add?.();
                    setWorkspaces(got?.list?.dirs ?? []);
                    /* 用户取消时 `dir` 是 null：不报错、不写回执（他什么都没做） */
                    if (!got?.dir) return;
                    showMaterialNote(addedNote(got.dir));
                  })();
                }}
              >
                ＋ {WORKSPACE_LABELS.add}
              </button>
            </div>
          ) : null}
        </div>

        {/*
          项目：原来是个**没有 onClick 的按钮**（点了一点反应没有）。
          现在挂上真下拉 —— 列出已有的项目，选中的会跟着这次任务走。
        */}
        <div className="wb-chip-wrap">
          <button
            className={`wb-chip${projectId ? " is-on" : ""}`}
            data-testid="wb-project"
            title="选择项目"
            onClick={() => togglePop("project")}
          >
            <Paperclip size={13} /> {projectName ?? "项目"} <ChevronDown size={12} />
          </button>
          {openPop === "project" ? (
            <div className="wb-chip-pop" data-testid="wb-project-pop" onMouseLeave={() => setOpenPop(null)}>
              {lib.projects.length === 0 ? (
                <div className="wb-chip-empty">还没有项目</div>
              ) : (
                lib.projects.map((p) => (
                  <button
                    key={p.id}
                    className={`wb-chip-option${projectId === p.id ? " is-on" : ""}`}
                    data-testid={`wb-project-option-${p.id}`}
                    onClick={() => {
                      setProjectId(p.id);
                      setOpenPop(null);
                    }}
                  >
                    <Paperclip size={13} /> {p.name} {projectId === p.id ? <Check size={13} /> : null}
                  </button>
                ))
              )}
              {projectId ? (
                <button
                  className="wb-chip-option"
                  data-testid="wb-project-clear"
                  onClick={() => {
                    setProjectId(null);
                    setOpenPop(null);
                  }}
                >
                  <X size={13} /> 不归入项目
                </button>
              ) : null}
            </div>
          ) : null}
        </div>

        {/* 按需确认：同样是**没有 onClick 的死按钮**，现在挂上真下拉 */}
        <div className="wb-chip-wrap">
          <button
            className="wb-chip"
            data-testid="wb-confirm"
            /* 同底部"选择方式"：可见文字是当前档位，名字里带上它 */
            aria-label={`执行前的确认策略：${confirmMode}`} title="执行前的确认策略"
            onClick={() => togglePop("confirm")}
          >
            <Check size={13} /> {confirmMode} <ChevronDown size={12} />
          </button>
          {openPop === "confirm" ? (
            <div
              className="wb-chip-pop wb-confirm-pop"
              data-testid="wb-confirm-pop"
              onMouseLeave={() => setOpenPop(null)}
            >
              {/* 2026-10-22：四档各配一句说明（原来四行纯文字，主人说太丑） */}
              <div className="wb-confirm-head">执行前问不问</div>
              {CONFIRM_MODES.map((m) => {
                const state = confirmOptionState(m, confirmMode);
                return (
                  <button
                    key={m}
                    className={`wb-chip-option${state.checked ? " is-on" : ""}`}
                    data-testid={`wb-confirm-option-${m}`}
                    /*
                     * T-06：radio 语义 + **只有一个勾**。
                     * 原来每个选项前都画了一个 Check，选中项再加一个 ——
                     * 三个全有勾（WorkBuddy 截图可见）。
                     */
                    role="menuitemradio"
                    aria-checked={state.checked}
                    onClick={() => {
                      setConfirmMode(m);
                      setOpenPop(null);
                    }}
                  >
                    <span className="wb-chip-check-slot">
                      {state.marker === "check" ? <Check size={13} /> : null}
                    </span>
                    <span className="wb-confirm-text"><b>{m}</b><em>{CONFIRM_HINT[m]}</em></span>
                  </button>
                );
              })}
            </div>
          ) : null}
        </div>

        {/*
          「技能」按钮打开的是**装过的**条目清单，点一下切换"这次用不用"。
          启用项会作为能力说明交给任务（见 library.ts 的 enabledPromptBlock）——
          上位是把 skill_id 交给服务端注入 schema，单机版没有那一层，
          所以退化成"在系统提示词里说清楚这次可以用什么"。
        */}
        <div className="wb-env">
          <button
            className="wb-chip"
            data-testid="wb-skills"
            title="选择这次任务要用的技能 / 插件"
            onClick={() => togglePop("skill")}
          >
            <Sparkles size={13} /> 技能
            {enabled.length > 0 ? <em className="wb-chip-badge">{enabled.length}</em> : null}
          </button>
          {/*
            命令面板（命令 + 推荐 + 搜索）—— 形态依据本体实机截图（§132）。
            原来这里列的是「已装条目 + 勾选」，与本体不是一回事。
          */}
          {openPop === "skill" ? (
            <SkillPanel
              onClose={() => setOpenPop(null)}
              canvasOpen={canvasOpen}
              /*
               * 命令区逐条接上（2026-10-14）：原来 `onPick` 根本没接，
               * 六条命令全是**死按钮**（点了没反应）。有后端的接上，没后端的
               * 在 `SkillPanel` 里如实标成 `todo`（禁用 + 悬停说明）。
               */
              onPick={(label) => {
                if (label === "创建画布") setCanvasOpen(true);
                if (label === "收起画布") setCanvasOpen(false);
                /* 选择项目 / 工作模式设置：就是输入区那两个 chip —— 把它的下拉打开 */
                /*
                 * 这两条是把技能面板**换成**输入区那个 chip 的下拉（开合共用 `openPop`），
                 * 所以返回 `false` 让面板别再调 `onClose()` —— 否则刚打开就被关掉。
                 */
                if (label === "选择项目") {
                  setOpenPop("project");
                  return false;
                }
                if (label === "工作模式设置") {
                  setOpenPop("confirm");
                  return false;
                }
                /* 技能管理：跳到插件页的**管理子页**（本体口径：直接进管理，不是先落市场） */
                if (label === "技能管理") { setPluginsIntent("manage"); setView("plugins"); }
                /* 反馈：本机版的反馈通道 = 导出诊断包（§2.4 #7）—— 成功/失败都要说出来 */
                if (label === "反馈") runFeedbackCommand(showMaterialNote);
                if (label !== "选择项目" && label !== "工作模式设置") setOpenPop(null);
              }}
            />
          ) : null}
        </div>

        {/*
          插件：原来是个**没有 onClick 的死按钮**（§124 的死按钮审计里报出来的）。
          旁边「技能」那个是完整下拉，但它的列表是**技能+插件混在一起**的 ——
          所以这个的位置是"只看插件"。
        */}
        <div className="wb-env">
          <button
            className="wb-chip"
            data-testid="wb-plugins"
            title="选择这次任务要用的插件"
            onClick={() => togglePop("plugin")}
          >
            <Blocks size={13} /> 插件
            {enabledPlugins.length > 0 ? <em className="wb-chip-badge">{enabledPlugins.length}</em> : null}
          </button>
          {openPop === "plugin" ? (
            <div className="wb-env-pop wb-skill-pop" data-testid="wb-plugin-pop">
              {installedPlugins.length === 0 ? (
                <div className="wb-skill-empty">还没安装任何插件。去「插件·技能·伙伴」里装几个。</div>
              ) : (
                installedPlugins.map((id) => {
                  const item = findItemIn(lib, id);
                  if (!item) return null;
                  const on = enabled.includes(id);
                  return (
                    <button
                      key={id}
                      className={`wb-env-option${on ? " is-on" : ""}`}
                      data-testid={`wb-plugin-toggle-${id}`}
                      onClick={() => enable(id)}
                    >
                      {item.name}
                      {on ? <Check size={13} /> : null}
                    </button>
                  );
                })
              )}
            </div>
          ) : null}
        </div>

        <span className="wb-spacer" />
        {/*
          2026-10-22 主人：「那个更多按钮取消 因为点击了更多按钮出来的工作条
          他不是弹出往左或者往右弹 是左右都弹 所以干脆不弹」——
          所有 chip 常显，一行平铺。
        */}
        {/* 模型 · 思考：真选择器（组件在 ModelChip.tsx） */}
        <ModelChip
          open={openPop === "model"}
          onToggle={() => {
            popToken.current += 1;
            togglePop("model");
          }}
          onClose={() => closePop(popToken.current)}
          busy={taskRunning}
          /* 「管理模型」→ 打开设置（开关在 NavSidebar；跨组件用一条 DOM 事件，不引全局 store） */
          onOpenSettings={() => window.dispatchEvent(new CustomEvent("dsh-open-settings"))}
        />
        {/* 思考强度是**另一颗**（主人的口径：模型一颗、档位一颗） */}
        <EffortChip
          open={openPop === "effort"}
          onToggle={() => {
            popToken.current += 1;
            togglePop("effort");
          }}
          onClose={() => closePop(popToken.current)}
        />

        {/* 2026-10-15 移除了那颗写死 `AUTO · LOW` 的「模型档位」chip：它显示的不是真实状态
            （项目里没有"档位"这层），而模型本来就能在设置里选。真做档位时它再带着功能回来。 */}
        {/*
          Token 用量（2026-10-14）：数从**当前任务的各步真实用量**合计来
          （`sumUsage` 逐项求和，吞吐量由 `usageRows` 用"总输出 ÷ 总耗时"现算）。
          没有任务、或 provider 没给用量时它显示空态 —— **不编数**。
        */}
        <ComposerSendButton
          running={running}
          hasText={text.trim() !== ""}
          {...(sendLabel ? { label: sendLabel } : {})}
          onSend={submit}
          onStop={() => useWorkbenchStore.getState().abort(activeTask?.id)}
        />
      </div>

      </div>

      {/*
        2026-10-22 主人：「本段对话这个按钮取消…位置还得往下，在输入框外的下面」——
        这行字在**卡片外面**（shell 的第二行），不是卡片内底部。
      */}
      <ComposerUsageLine usage={sumUsage((activeTask?.steps ?? []).map((s) => s.usage))} />

      {enabledNames.length > 0 ? (
        <div className="wb-composer-chips" data-testid="wb-enabled-chips">
          {enabledNames.map((name) => (
            <span className="wb-composer-chip" key={name}>
              <Sparkles size={11} /> {name}
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/* ============================================================
 * 首页（blob + 今天有什么工作要处理? + 为你推荐）
 * ============================================================ */

  /* ⚠️ 2026-10-16：「模型 · 思考」那颗 chip 搬进  了 —— 它自己带着下拉与落盘，
     这里只剩一个挂载点（结构守卫也不允许这个文件再长，拆是对的）。 */