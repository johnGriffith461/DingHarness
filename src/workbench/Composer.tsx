/**
 * 从 `Workbench.tsx` 拆出来的（C6-1）。**纯挪位**：一个字没改，只加了 export 与 import。
 * 拆的理由见 `docs/PLAN-C6-结构拆分.md`：那个文件 2188 行、14 个顶层组件，
 * 改一处要读两千行 —— 于是「顺手加一行」变成默认做法。
 */

import { useEffect, useRef, useState } from "react";
import { Blocks, Check, ChevronDown, Paperclip, Plus, Send, Sparkles, X } from "lucide-react";
import { useWorkbenchStore } from "./store";
import { PHRASE_LABELS, applyPhrase, detectAtTrigger, filterPhrases, phraseGroups, type AtTrigger, type Phrase } from "@shared/phrases";
import { COMPOSER_PLACEHOLDER } from "./copy";
import { resolveImportedMaterials } from "./materialImport";
import { UPLOAD_REASON_LABEL } from "@shared/upload";
import type { ShellBridge } from "@shared/ipc";
import { WORKSPACE_LABELS, addedNote, workspaceLabel } from "@shared/workspace";
import { fileContextBlock } from "./fileContext";
import { useLibraryStore } from "./libraryStore";
import { findItemIn } from "./libraryStore";
import { type ConfirmMode } from "@shared/permissions";
import { useDocStore } from "./docStore";
import { readConfirmMode, saveConfirmMode } from "./confirmMode";
import { Square } from "lucide-react";
import SkillPanel from "./SkillPanel";

import { CONFIRM_MODES } from "./uiUtil";

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
  onSend?: (text: string, options?: { material?: string }) => void;
}) {
  /** 正在跑一轮（流式）—— 决定发送键是「发送」还是「停止」（补完⑤）。 */
  const running = useWorkbenchStore((st) => Boolean(st.runningRequestId));
  const createTask = useWorkbenchStore((s) => s.createTask);
  const canvasOpen = useWorkbenchStore((s) => s.canvasOpen);
  const setCanvasOpen = useWorkbenchStore((s) => s.setCanvasOpen);
  const setView = useWorkbenchStore((s) => s.setView);
  const setPluginsIntent = useWorkbenchStore((s) => s.setPluginsIntent);
  const [text, setText] = useState("");

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
  const [materialNote, setMaterialNote] = useState("");

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
  }, [takeComposerDraft]);

  /*
   * 输入区那几个 chip 的下拉，**共用一个"当前打开的是哪个"状态**。
   *
   * 原来是四个独立布尔（projectOpen / confirmOpen / skillOpen / pluginOpen）——
   * 开第二个时不会关掉第一个，两个浮层就**叠在一起**（用户报的）。
   *
   * 换成单值之后，"最多只有一个开着"是**结构上保证的**，不靠每处记得去关别人。
   * 以后再加 chip 也不会重犯这个问题。
   */
  const [openPop, setOpenPop] = useState<null | "project" | "confirm" | "skill" | "plugin" | "add">(null);
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
  const [confirmMode, setConfirmModeState] = useState<ConfirmMode>(() => readConfirmMode());
  const setConfirmMode = (mode: ConfirmMode): void => {
    saveConfirmMode(mode);
    setConfirmModeState(mode);
  };

  /**
   * 切换某个下拉的开合：开的若是它自己就关掉，否则换成它。
   *
   * @param which 要切换的下拉
   */
  const togglePop = (which: "project" | "confirm" | "skill" | "plugin" | "add"): void =>
    setOpenPop((cur) => (cur === which ? null : which));

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
    setText("");
    /*
     * 资料在**发送这一刻**读成文本（不是附着那一刻）：
     * 用户可能先把文件挂上、过一会儿才发，中间还改过文件 —— 发的是**发的时候**那份内容。
     * 读不到就如实写"读不到"（`fileContextBlock` 负责），绝不编。
     */
    let block = "";
    const shell = (globalThis as unknown as { shell?: ShellBridge }).shell;
    if (material.length) {
      const reads = [];
      for (const file of material) {
        const text = await Promise.resolve(shell?.drive?.read?.(file.path)).catch(() => null);
        reads.push({ path: file.path, text: typeof text === "string" ? text : null });
      }
      block = fileContextBlock(reads);
    }
    setMaterial([]);
    const options = block ? { material: block } : undefined;
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
  const inputRef = useRef<HTMLTextAreaElement | null>(null);

  /** 光标一动就重算（输入、点、方向键都算）。 */
  const syncTrigger = (el: HTMLTextAreaElement): void => {
    const next = detectAtTrigger(el.value, el.selectionStart ?? el.value.length);
    setAtTrigger(next);
    /* 第一次唤起选单时把云盘清单读进来（点选即附着，不用再点一次"添加资料"）。 */
    if (next && driveFiles.length === 0) void loadDriveFiles();
  };

  const matched = atTrigger ? filterPhrases(atTrigger.query) : [];

  /** 选中一条：替换 `@查询词`，并把光标放到插入内容的末尾。 */
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
    <div className="wb-composer" data-testid="wb-composer">
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
          <div className="wb-phrase-head">{PHRASE_LABELS.title}</div>
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
          {matched.length === 0 ? (
            <p className="wb-phrase-empty" data-testid="wb-phrase-empty">
              {PHRASE_LABELS.empty}
            </p>
          ) : (
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
      <textarea
        ref={inputRef}
        className="wb-composer-input"
        data-testid="wb-composer-input"
        rows={2}
        placeholder={placeholder}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
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
        onBlur={() => setAtTrigger(null)}
        onKeyDown={(e) => {
          // 选单开着时：Esc 收起、Enter 选第一条（别让它顺手把消息发出去）
          if (atTrigger) {
            if (e.key === "Escape") {
              e.preventDefault();
              setAtTrigger(null);
              return;
            }
            if (e.key === "Enter" && !e.shiftKey && matched.length) {
              e.preventDefault();
              pickPhrase(matched[0] as Phrase);
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
                    setMaterialNote(parts.length ? parts.join("；") : picked.length ? `已添加 ${picked.length} 个文件` : "");
                    window.setTimeout(() => setMaterialNote(""), 4000);
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
                          setMaterialNote(WORKSPACE_LABELS.removedNote);
                          window.setTimeout(() => setMaterialNote(""), 4000);
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
                    setMaterialNote(addedNote(got.dir));
                    window.setTimeout(() => setMaterialNote(""), 6000);
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
            <div className="wb-chip-pop" data-testid="wb-confirm-pop" onMouseLeave={() => setOpenPop(null)}>
              {CONFIRM_MODES.map((m) => (
                <button
                  key={m}
                  className={`wb-chip-option${confirmMode === m ? " is-on" : ""}`}
                  data-testid={`wb-confirm-option-${m}`}
                  onClick={() => {
                    setConfirmMode(m);
                    setOpenPop(null);
                  }}
                >
                  <Check size={13} /> {m} {confirmMode === m ? <Check size={13} /> : null}
                </button>
              ))}
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
                if (label === "技能管理") {
                  setPluginsIntent("manage");
                  setView("plugins");
                }
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
          ⚠️ 模型档位标 disabled（§124 的死按钮审计报出）。

          它显示的是**写死的"自动 低"** —— 而项目里并没有"档位"这个概念：
          本机版已有 `resolveRoute` / `readSavedRoute`（读写保存的通道），
          但没有"把模型/思考档位分成几档"的那一层。

          所以属于"参考里有、我还没做"，按标准禁用并记进待做。
        */}
        <button className="wb-chip" title="模型档位（本机版还没做档位选择）" disabled>
          自动 <ChevronDown size={12} /> 低
        </button>
        {/*
          ⚠️ **流式过程中这里是「停止」**（补完⑤）。
          在此之前，工作台**没有任何停止入口**：`store.abort()` 实现了却只有提问卡的"关闭"
          在调它 —— 用户发出去一条要跑一分钟的任务，就只能干看着（聊天侧早有 `chat-send-stop`，
          两边不一致）。
          这里点下去走的是 store 的 `abort()` → `abortStream(requestId)` → 主进程
          `controller.abort()`（**连 provider 侧的连接一起断**，不是只停界面）。

          文案取自本体证据：`button_stop` = 「停止」。
        */}
        {running ? (
          <button
            className="wb-send is-stop"
            data-testid="wb-send-stop"
            aria-label="停止" title="停止"
            onClick={() => useWorkbenchStore.getState().abort()}
          >
            <Square size={14} />
          </button>
        ) : (
          <button
            className="wb-send"
            data-testid="wb-send"
            disabled={!text.trim()}
            aria-label={sendLabel ?? "发送（Enter）"}
            title={sendLabel ?? "发送（Enter）"}
            onClick={submit}
          >
            <Send size={15} />
          </button>
        )}
      </div>

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

