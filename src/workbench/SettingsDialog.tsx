/**
 * 从 `Workbench.tsx` 拆出来的（C6-1）。**纯挪位**：一个字没改，只加了 export 与 import。
 * 拆的理由见 `docs/PLAN-C6-结构拆分.md`：那个文件 2188 行、14 个顶层组件，
 * 改一处要读两千行 —— 于是「顺手加一行」变成默认做法。
 */

import { useEffect, useState } from "react";
import { Brain, ChevronRight, CircleDollarSign, Crown, Info, SlidersHorizontal, User, Volume2, X } from "lucide-react";
import { useWorkbenchStore } from "./store";
import { SETTINGS_LABELS, pinnedLabel, pinnedStatus, routeOptions } from "@shared/settings";
import { useAppSettings } from "./appSettings";
import { listProviders } from "@/ai/aiClient";
import { useMemoryStore } from "./memoryStore";
import MemoryPanel from "./MemoryPanel";
import SettingsPages, { type SettingsSubPage } from "./SettingsPages";
import { listVoices, readVoiceName, saveVoiceName } from "./tts";

export function SettingsDialog({ onClose }: { onClose: () => void }) {
  /*
   * 记忆面板的开合与真实条数。
   *
   * 条数从 store 取 —— 写死一个"已启用"是之前那个错误说法的来源之一。
   */
  /** 当前在设置的哪个子页（null = 显示主列表）。 */
  const [subPage, setSubPage] = useState<SettingsSubPage | null>(null);
  const [memoryOpen, setMemoryOpen] = useState(false);
  const memCount = useMemoryStore((s) => s.lib.entries.length);
  /** 记忆开关（列表里那一行的 value 用它）。 */
  const memOn = useMemoryStore((s) => s.lib.enabled !== false);
  /** 新对话默认模型（§183）：空串 = 记忆上次。 */
  const pinnedModel = useAppSettings((s) => s.pinnedModel);
  /** 可选的通道（从 provider 列表摊出来）。 */
  const [modelChoices, setModelChoices] = useState<Array<{ provider: string; model: string; label: string }>>([]);
  useEffect(() => {
    // 这个组件本身就是设置弹窗：挂载时列一次就够了
    void (async () => {
      try {
        const providers = await listProviders();
        setModelChoices(routeOptions(providers));
      } catch {
        setModelChoices([]);
      }
    })();
  }, []);
  /** 钉住的默认模型现在还能用吗（§184）。 */
  const pinnedDead =
    pinnedStatus(
      pinnedModel,
      modelChoices.map((c) => `${c.provider}/${c.model}`),
    ) === "dead";
  const loadMemory = useMemoryStore((s) => s.load);
  useEffect(() => {
    void loadMemory();
  }, [loadMemory]);
  const [voiceOpen, setVoiceOpen] = useState(false);
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  const [voiceName, setVoiceName] = useState(() => readVoiceName());

  // getVoices() 第一次常是空的，要听 voiceschanged（见 tts.ts 里的说明）
  useEffect(() => listVoices(setVoices), []);

  /*
   * 「套餐」在本机版的真实对应物就是**当前在用的模型通道** —— 写死一个「已开通」
   * 什么都没说明，用户想知道的是"我这些话是谁在回答"。
   * 没设置过时如实说"还没选"，并说明首次发消息会自动挑一个（那是实际行为）。
   */
  const channel = (() => {
    try {
      const raw = localStorage.getItem("dsh-canvas.chat-settings");
      if (!raw) return "";
      const parsed = JSON.parse(raw) as { provider?: string; model?: string };
      const provider = parsed.provider ?? "";
      const model = parsed.model ?? "";
      return provider ? `${provider}${model ? ` · ${model}` : ""}` : "";
    } catch {
      return "";
    }
  })();
  const rows = [
    /*
      标准套餐：对应本体 `chat/settings/profile`（独立页）。
      它原来带 `todo`，而渲染里 `disabled={Boolean(r.todo)}` —— 于是整行点不动。
      `todo` 的语义是"这行为什么不可用"，这里不该用它：通道信息改成 `value` 的副标题。
    */
    {
      group: 0,
      icon: <Crown size={13} />,
      label: "标准套餐",
      value: channel || "还没选模型通道",
    },
    /* 账号：对应本体 chat/settings/account（独立页） */
    { group: 0, icon: <User size={13} />, label: "账号", value: "本机模式" },
    /*
      通用（§182）：记忆开关与「开启新话题」都在这儿。
      这一行的 value 直接显示**记忆现在开着没有** —— 在设置列表里就能看见状态，
      不用点进去才发现。
    */
    {
      group: 0,
      icon: <SlidersHorizontal size={13} />,
      label: "通用",
      /*
       * 这一行的 value 把两件事都说了：记忆开着没有 + 新对话默认模型是什么。
       * 设置列表里就能看见状态，不用点进去才发现（§182 定的规矩）。
       */
      /*
       * 钉住的模型要是**现在不可用**，这一行直接标出来（§184）：
       * 不能让用户以为默认在用 A、其实早就退回上次了。
       */
      value: `${SETTINGS_LABELS.memory}${memOn ? SETTINGS_LABELS.memoryOn : SETTINGS_LABELS.memoryOff} · ${
        SETTINGS_LABELS.defaultModel
      }${pinnedLabel(pinnedModel)}${pinnedDead ? "（不可用）" : ""}`,
    },
    /* 关于（§182）：只说本机这一份的事实 */    { group: 1, icon: <Info size={13} />, label: "关于", value: "" },
    { group: 0, icon: <CircleDollarSign size={13} />, label: "订阅与额度管理", todo: "需要账号服务端，本机版没有" },
    { group: 1, icon: <Volume2 size={13} />, label: "声音选择" },
    /*
      记忆：原来写着「本机版没有」+ 写死的"已启用" —— 那是**错的**。
      本体路由里有 `chat/memory/list|clear|delete`，它就是个真实功能，
      内容存本地一样成立。现在 value 显示**真实条数**，点开就是记忆面板。
    */
    { group: 1, icon: <Brain size={13} />, label: "记忆", value: memCount === 0 ? "暂无" : `${memCount} 条` },
  ];
  return (
    <div className="wb-modal-mask" onClick={onClose} data-testid="wb-settings">
      <div className="wb-modal" onClick={(e) => e.stopPropagation()}>
        <button className="wb-modal-close" onClick={onClose} aria-label="关闭" title="关闭">
          <X size={15} />
        </button>
        <div className="wb-modal-avatar" />
        <div className="wb-modal-name">
          本机用户 <ChevronRight size={13} />
        </div>
        <div className="wb-modal-id">本机模式 · 未登录</div>
        <button className="wb-modal-primary" disabled title="本机版没有账号服务端">账号管理</button>

        {subPage ? (
          <SettingsPages
            page={subPage}
            pinned={pinnedModel}
            choices={modelChoices}
            onBack={() => setSubPage(null)}
            /*
             * 「开启新话题」：真的开一段新对话（新任务 = 空上下文），
             * 并照 `settings_clear_context_toast_new` 说一句「已开启新话题」。
             */
            onNewTopic={() => {
              /*
               * 「开启新话题」= 回到「新工作任务」的空上下文状态（§182）。
               * 用视图切换而不是"再造一个空任务"：后者会在历史里留一条空任务。
               */
              useWorkbenchStore.getState().setView("home");
              setSubPage(null);
              onClose();
            }}
          />
        ) : (
          <>
        {[0, 1].map((group) => (
          <div className="wb-modal-group" key={group}>
            {rows
              .filter((r) => r.group === group)
              .map((r) => (
                <div key={r.label}>
                  <button
                    className={`wb-modal-row${r.todo ? " is-todo" : ""}`}
                    data-testid={`wb-set-${r.label}`}
                    title={r.todo ?? ""}
                    disabled={Boolean(r.todo)}
                    onClick={() => {
                      if (r.label === "记忆") {
                        setMemoryOpen((v) => !v);
                        return;
                      }
                      if (r.label === "声音选择") {
                        setVoiceOpen((v) => !v);
                        return;
                      }
                      /*
                        标准套餐 / 账号：本体里是**独立路由**
                        （`chat/settings/profile` / `chat/settings/account`），
                        我把它们做成了弹窗里的子页（同「记忆」那套做法）。
                      */
                      if (r.label === "标准套餐") {
                        setSubPage("profile");
                        return;
                      }
                      if (r.label === "通用") {
                        setSubPage("general");
                        return;
                      }
                      if (r.label === "关于") {
                        setSubPage("about");
                        return;
                      }
                      if (r.label === "账号") {
                        setSubPage("account");
                        return;
                      }
                    }}
                  >
                    <span className="wb-modal-row-icon">{r.icon}</span>
                    <span className="wb-modal-row-label">{r.label}</span>
                    {/*
                      声音选择这一行现在显示**实际选中的音色**，不是写死的「温柔桃子」——
                      写死的值会让人以为设置生效了，其实朗读用的是系统默认。
                    */}
                    {r.label === "声音选择" ? (
                      <em data-testid="wb-set-voice-value">{voiceName || "系统默认"}</em>
                    ) : r.value && r.label === "外观" ? (
                      <em data-testid="wb-set-theme-value">{r.value}</em>
                    ) : r.value ? (
                      <em>{r.value}</em>
                    ) : null}
                    <ChevronRight size={13} />
                  </button>
                  {r.label === "记忆" && memoryOpen ? <MemoryPanel /> : null}
                  {r.label === "声音选择" && voiceOpen ? (
                    <div className="wb-voice-list" data-testid="wb-voice-list">
                      {voices.length === 0 ? (
                        <div className="wb-voice-empty">这台机器上没有可选的朗读音色</div>
                      ) : (
                        <>
                          <button
                            className={`wb-voice-item${voiceName ? "" : " is-on"}`}
                            data-testid="wb-voice-default"
                            onClick={() => {
                              saveVoiceName("");
                              setVoiceName("");
                            }}
                          >
                            系统默认
                          </button>
                          {voices.map((v) => (
                            <button
                              className={`wb-voice-item${voiceName === v.name ? " is-on" : ""}`}
                              key={v.name}
                              data-testid={`wb-voice-${v.name}`}
                              onClick={() => {
                                saveVoiceName(v.name);
                                setVoiceName(v.name);
                              }}
                            >
                              {v.name}
                              <em>{v.lang}</em>
                            </button>
                          ))}
                        </>
                      )}
                    </div>
                  ) : null}
                </div>
              ))}
          </div>
        ))}
          </>
        )}
      </div>
    </div>
  );
}

/* ============================================================
 * 外壳
 * ============================================================ */

