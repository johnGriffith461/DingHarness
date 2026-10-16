/**
 * 从 `Workbench.tsx` 拆出来的（C6-1）。**纯挪位**：一个字没改，只加了 export 与 import。
 * 拆的理由见 `docs/PLAN-C6-结构拆分.md`：那个文件 2188 行、14 个顶层组件，
 * 改一处要读两千行 —— 于是「顺手加一行」变成默认做法。
 */

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Search, Blocks, Sparkles, Brain, ChevronRight, CircleDollarSign, Crown, Info, SlidersHorizontal, User, X } from "lucide-react";
import { useWorkbenchStore } from "./store";
import { SETTINGS_LABELS, pinnedLabel, pinnedStatus, routeOptions } from "@shared/settings";
import { useAppSettings } from "./appSettings";
import { listProviders } from "@/ai/aiClient";
import { useMemoryStore } from "./memoryStore";
import MemoryPanel from "./MemoryPanel";
import SettingsPages, { type SettingsSubPage } from "./SettingsPages";
import { THEME_OPTIONS, readTheme } from "./theme";

/** 左轨的两段（照 ZCode 的分段：能力在前、基础在后）。 */
const GROUP_LABEL: Record<number, string> = {
  0: "Agent 能力",
  1: "基础设置",
};

/** 主题的展示名（跟随系统 / 浅色模式 / 深色模式）—— 读的是**当前生效**的那一格。 */
function themeLabelOf(): string {
  const t = readTheme();
  return THEME_OPTIONS.find((o) => o.value === t)?.label ?? t;
}

export function SettingsDialog({ onClose }: { onClose: () => void }) {
  /*
   * 记忆面板的开合与真实条数。
   *
   * 条数从 store 取 —— 写死一个"已启用"是之前那个错误说法的来源之一。
   */
  /** 当前在设置的哪个子页（null = 显示主列表）。 */
  const [subPage, setSubPage] = useState<SettingsSubPage | null>(null);
  /** 分区搜索词（ZCode 的 `SettingsSearchInput` 的最小可用版）。 */
  const [setQuery, setSetQuery] = useState("");
  /** 当前分区名（面包屑用）—— 点哪一项就记哪个，不靠 subPage 反查（一个分区可能开多个子页）。 */
  const [sectionLabel, setSectionLabel] = useState("");
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

  /*
   * 首屏卡片上那一格「主题」。
   * 只在渲染时读一次会**滞后**：用户在「通用」里换完主题、返回首屏，卡片还写着旧的。
   * 主题就是 `<html data-theme>` 这个属性（theme.ts:106 定的载体），所以直接听它。
   */
  const [themeLabel, setThemeLabel] = useState(() => themeLabelOf());
  useEffect(() => {
    const mo = new MutationObserver(() => setThemeLabel(themeLabelOf()));
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => mo.disconnect();
  }, []);

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
    /*
      记忆：原来写着「本机版没有」+ 写死的"已启用" —— 那是**错的**。
      本体路由里有 `chat/memory/list|clear|delete`，它就是个真实功能，
      内容存本地一样成立。现在 value 显示**真实条数**，点开就是记忆面板。
    */
    { group: 0, icon: <Blocks size={13} />, label: "插件·技能·伙伴", value: "" },
    { group: 1, icon: <Sparkles size={13} />, label: "模型", value: "provider / 模型 / 拉取" },
    { group: 1, icon: <Brain size={13} />, label: "记忆", value: memCount === 0 ? "暂无" : `${memCount} 条` },
  ];
  return createPortal(
    <div className="wb-setfull" data-testid="wb-settings">
      {/* 整页顶部：返回 + 标题（ZCode 的设置也是一整页，顶部是它的层级区） */}
      <div className="wb-setfull-bar">
        <button className="wb-setfull-back" data-testid="wb-settings-back" onClick={onClose} aria-label="返回工作台" title="返回工作台">
          ‹ 返回
        </button>
        <b>设置</b>
        <span className="wb-spacer" />
        {/*
          ⚠️ 2026-10-16：这两颗原来在 `.wb-setfull-body` 里，是**模态时代**留下的孤儿
          （`.wb-modal-name`「本机用户 ›」/ `.wb-modal-id`「本机模式 · 未登录」/ `.wb-modal-close`）——
          整页化之后它们在 body 里没有定位约束，就散在左上角、还压在导航上（主人截图里那两行飘着的字就是它们）。
          身份那句挪进顶栏如实显示；关闭收成顶栏右侧一颗 ✕（「返回」也在，两个都能关）。
          旧的类名不再用：它们带着模态的定位样式，正是当初把整页顶坏的那一批。
        */}
        <span className="wb-setfull-mode" data-testid="wb-set-mode">本机模式 · 未登录</span>
        <button className="wb-setfull-close" data-testid="wb-settings-close" onClick={onClose} aria-label="关闭设置" title="关闭设置">
          <X size={15} />
        </button>
      </div>
      <div className="wb-setfull-body">
        {/* ⚠️ 2026-10-16：改成 **ZCode 的两列形态** —— 左列是分区，右列是内容。
            原来这里是"要么一列行、要么整块子页"（二选一）—— 那看不出"我在哪一层"。
            ⚠️ 面包屑 / 搜索框还没加（见 docs/ZCODE-设置与模型选择-反解.md 的清单）。 */}
        <div className="wb-set-shell">
          <nav className="wb-set-rail" data-testid="wb-set-rail">
            {/* 搜索：分区一多就得能搜（ZCode 的 SettingsSearchInput） */}
            <label className="wb-set-search">
              <Search size={12} />
              <input
                data-testid="wb-set-search"
                placeholder="搜设置项"
                value={setQuery}
                onChange={(e) => setSetQuery(e.target.value)}
              />
            </label>
          {[0, 1].map((group) => (
            <div className="wb-modal-group" key={group}>
            {/* 分组标题：ZCode 的左列是按组分段的（基础设置 / Agent 能力 / …） */}
            <div className="wb-set-group" data-testid={`wb-set-group-${group}`}>
              {GROUP_LABEL[group] ?? ""}
            </div>
              {rows
                .filter((r) => r.group === group && (!setQuery.trim() || r.label.includes(setQuery.trim())))
                .map((r) => (
                  <div key={r.label}>
                    <button
                      className={`wb-modal-row${r.todo ? " is-todo" : ""}`}
                      data-testid={`wb-set-${r.label}`}
                      title={r.todo ?? ""}
                      disabled={Boolean(r.todo)}
                      onClick={() => {
                        setSectionLabel(r.label);
                        if (r.label === "插件·技能·伙伴") {
                          setSubPage("plugins");
                          return;
                        }
                        if (r.label === "模型") {
                          setSubPage("models");
                          return;
                        }
                        if (r.label === "记忆") {
                          setMemoryOpen((v) => !v);
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
                        ⚠️ 2026-10-16：这里原来还有一行「声音选择」的值（显示实际选中的音色）——
                        主人说那一行没用（「声音选择，有必要吗，没用啊，不要了」），
                        整行连它的音色列表一起拆了。朗读还在（用系统默认音色），
                        只是不再让你挑音色。
                      */}
                      {r.value && r.label === "外观" ? (
                        <em data-testid="wb-set-theme-value">{r.value}</em>
                      ) : r.value ? (
                        <em>{r.value}</em>
                      ) : null}
                      <ChevronRight size={13} />
                    </button>
                    {r.label === "记忆" && memoryOpen ? <MemoryPanel /> : null}
                  </div>
                ))}
            </div>
          ))}
          </nav>
          {/* 左列底部：账号（照 ZCode 图二左下角那块） */}
          <div className="wb-setfull-account" data-testid="wb-setfull-account">
            <span className="wb-setfull-avatar" aria-hidden />
            <span>本机用户 · 标准套餐</span>
          </div>
          <section className="wb-set-panel" data-testid="wb-set-panel">
            {/* 面包屑：告诉用户"我在哪一层"（ZCode 的 settings-header-breadcrumb） */}
            <div className="wb-set-crumb" data-testid="wb-set-crumb">
              <button className="wb-set-crumb-root" data-testid="wb-set-crumb-root" onClick={() => { setSubPage(null); setSectionLabel(""); }}>
                设置
              </button>
              <span>›</span>
              <b>{sectionLabel || "选一项"}</b>
            </div>
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
                <h1 className="wb-set-title" data-testid="wb-set-title">
                  {sectionLabel || "设置"}
                </h1>
                <div className="wb-set-hint" data-testid="wb-set-hint">
                  设置都存在这台机器上：没有账号体系、没有云盘。左边选一项，或点下面的卡片。
                </div>
                {/*
                  ⚠️ 2026-10-16：这一屏原来是**一句提示 + 大半页空白**（主人截图上骂的就是这个：
                  "你这是啥设置页面啊"）。现在换成几张卡片：每张都显示**当前真值**
                  （默认通道 / 记忆条数 / 主题 / 身份），点进去就是对应那一页。
                  值是现算的 —— 卡片上不许写死任何一句"已启用"。
                */}
                <div className="wb-card-grid">
                  {[
                    { key: "models", label: "模型", value: pinnedLabel(pinnedModel), desc: pinnedDead ? "钉住的这个现在不可用" : "新对话默认用它" },
                    {
                      key: "memory",
                      label: "记忆",
                      value: memOn ? (memCount === 0 ? "暂无条目" : `${memCount} 条`) : "已关闭",
                      desc: memOn ? "跨对话记住的事" : "关掉了，不会记",
                    },
                    { key: "theme", label: "主题", value: themeLabel, desc: "纸白 / 暖墨两档" },
                    { key: "plugins", label: "插件·技能·伙伴", value: "管理", desc: "本机装的东西都在这儿" },
                    { key: "account", label: "账号", value: "本机模式", desc: "本机版没有账号服务端" },
                  ].map((c) => (
                    <button
                      key={c.key}
                      className="wb-card wb-card-link"
                      data-testid={`wb-homecard-${c.key}`}
                      onClick={() => {
                        if (c.key === "memory") {
                          setMemoryOpen(true);
                          setSectionLabel("记忆");
                          return;
                        }
                        if (c.key === "theme" || c.key === "account") {
                          setSubPage(c.key === "theme" ? "general" : "account");
                          setSectionLabel(c.key === "theme" ? "通用" : "账号");
                          return;
                        }
                        setSubPage(c.key === "models" ? "models" : "plugins");
                        setSectionLabel(c.key === "models" ? "模型" : "插件·技能·伙伴");
                      }}
                    >
                      <div className="wb-card-head">{c.label}</div>
                      <div className="wb-card-value" data-testid={`wb-homecard-value-${c.key}`}>{c.value}</div>
                      <div className="wb-card-note">{c.desc}</div>
                    </button>
                  ))}
                </div>
              </>
            )}
          </section>
        </div>
      </div>
    </div>,
    /*
     * ⚠️ 挂载点必须是 `.wb`（工作台根），**不是 `document.body`**。
     *
     * 这条路径上两个失败方式都踩过（2026-10-16，主人两次截图）：
     * ① 就地渲染 → `position: fixed` 被左栏那层的 containing block 框住，
     *    整页被挤成左栏里的一条窄柱；
     * ② 挂到 `document.body` → **设计令牌全丢**。令牌（`--bg` / `--fg` / `--surface` /
     *    `--win-titlebar-h` …）是定义在 `.wb` 上的，body 上的后代一个都拿不到，
     *    于是 `background: var(--surface)` 失效成透明（主页从底下透出来）、
     *    `inset: var(--win-titlebar-h) 0 0 0` 整条失效成 `auto`（整页塌回静态位置）。
     * `.wb` 既是令牌的载体、又是铺满窗口的根 —— 挂在它下面，①②一起没了。
     */
    document.querySelector(".wb") ?? document.body,
  );
}

/* ============================================================
 * 外壳
 * ============================================================ */

