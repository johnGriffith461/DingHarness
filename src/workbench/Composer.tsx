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
import { useLibraryStore } from "./libraryStore";
import { findItemIn } from "./libraryStore";
import { type ConfirmMode } from "@shared/permissions";
import { useDocStore } from "./docStore";
import { readConfirmMode, saveConfirmMode } from "./confirmMode";
import SkillPanel from "./SkillPanel";

import { CONFIRM_MODES } from "./uiUtil";

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
  onSend?: (text: string) => void;
}) {
  const createTask = useWorkbenchStore((s) => s.createTask);
  const [text, setText] = useState("");

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

  const submit = () => {
    const value = text.trim();
    if (!value) return;
    setText("");
    // 传了 onSend 就按它的（任务视图 = 在这段对话里接着说）；没传就是新开一段
    if (onSend) onSend(value);
    else void createTask(value);
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
    setAtTrigger(detectAtTrigger(el.value, el.selectionStart ?? el.value.length));
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
            title="更多"
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
              <span className="wb-chip-hint">附件：本机版还没接原生文件对话框</span>
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
            title="执行前的确认策略"
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
            <SkillPanel onClose={() => setOpenPop(null)} />
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
        <button
          className="wb-send"
          data-testid="wb-send"
          disabled={!text.trim()}
          title={sendLabel ?? "发送（Enter）"}
          onClick={submit}
        >
          <Send size={15} />
        </button>
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

