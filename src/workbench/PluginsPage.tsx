/**
 * 从 `pages.tsx` 拆出来的（C6-2）。**纯挪位**：一个字没改，只加了 export 与 import。
 * 拆分理由原本记在 `docs/PLAN-C6-结构拆分.md`（那个文件 1669 行 / 7 个顶层组件）。
 * ⚠️（该依据未入库、本机也找不到 —— 决策链断在这里，无法复核；以本文件里的断言与实现为准）
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { ShellBridge } from "@shared/ipc";
import { SEARCH_LABELS, hitLabel, placeholderFor, searchItems } from "@shared/search";
import { MCP_LABELS } from "@shared/mcp";
import { SearchHistoryStrip } from "./SearchHistoryStrip";
import { useSearchHistoryStore } from "./searchHistoryStore";
import { Check, ChevronDown, Plus, Search, Settings2, X } from "lucide-react";
import { NavCollapseButton } from "./NavCollapseButton";
import { ADMIN_TABS } from "./copy";
import { FEATURED_ITEMS, RECOMMENDED_PLUGINS, SKILL_GROUPS, type CatalogItem } from "./catalog";
import { catalogIcon } from "./catalogIcon";
import { findItemIn, useLibraryStore } from "./libraryStore";
import { useWorkbenchStore } from "./store";
import { useTransientNote } from "@/utils/transientNote";

import { PLUGIN_CATEGORIES } from "./ScheduledPage";
import { ChevronRight } from "./pagesUtil";
import { PluginCard } from "./PluginCard";

export function PluginsPage() {
  const [tab, setTab] = useState<(typeof ADMIN_TABS)[number]>("插件");
  const [category, setCategory] = useState<string>("精选");
  const installed = useLibraryStore((s) => s.lib.installed);
  const enabled = useLibraryStore((s) => s.lib.enabled);
  const install = useLibraryStore((s) => s.install);
  const enable = useLibraryStore((s) => s.enable);

  /** 市场 / 管理 两级（实机是子页，不是弹窗）。 */
  const [mode, setMode] = useState<"market" | "manage">("market");

  /*
   * 技能面板的「技能管理」把我们送到这里时，直接落到**管理子页**（本体口径）。
   * 取出即清（见 `store.setPluginsIntent`）—— 不清的话，用户下次自己点进插件页
   * 也会莫名其妙停在管理页。
   */
  const takePluginsIntent = useWorkbenchStore((s) => s.takePluginsIntent);
  useEffect(() => {
    if (takePluginsIntent() === "manage") {
      setManageTab("插件");
      setMode("manage");
    }
  }, [takePluginsIntent]);
  /* 技能搜索（§160）：`search_skills_input_placeholder` = 搜索技能 */
  const [skillQuery, setSkillQuery] = useState("");
  const recordSearch = useSearchHistoryStore((s) => s.record);
  /**
   * 什么时候算"搜过一次"：按回车、或离开输入框时（**不是每敲一个字都记**）。
   * 带参调用是给"清除"用的：清空**不算搜过**，不能往历史里塞一条空记录
   * （`setSkillQuery("")` 是异步的，这里读闭包只会读到旧值，所以必须显式传）。
   */
  const commitSkillQuery = (next?: string): void => {
    const q = next ?? skillQuery;
    if (q.trim()) recordSearch("skills", q);
  };
  /** 管理页的三 tab：插件 / 技能 / **连接器**（与市场页的「工作伙伴」不同）。 */
  const [manageTab, setManageTab] = useState<"插件" | "技能" | "连接器">("插件");

  /*
   * ── 连接器（MCP server，2026-10-14）──
   *
   * 这个页签原来写着「本机版不含连接器体系」—— 那是**当时的事实**，不是设计。
   * 现在 MCP 接上了：一个连接器就是一条命令（stdio），连上之后它把自己的工具交给 agent。
   * 这里只做三件真事：**看见状态**（连上了没、给了几个工具、为什么没连上）、
   * 「打开配置文件」、「重新连接」。
   *
   * 为什么不在界面里做"填命令/参数"的表单：那要一整套输入校验与编辑体验，
   * 而当前价值最高的是"能连上、能用"（主人原话：先做功能）。配置在 `mcp.json` 里。
   */
  const [mcp, setMcp] = useState<{
    file: string;
    empty: string;
    servers: Array<{
      name: string;
      command: string;
      args: string[];
      enabled: boolean;
      status: string;
      line: string;
      error: string;
      tools: Array<{ localName: string; name: string; description: string }>;
    }>;
  } | null>(null);
  /* 提示条自己会消失（P91）：句柄由 hook 管，后一条不许被前一条的定时器提前擦掉 */
  const [mcpNote, showMcpNote] = useTransientNote(3000);

  const pullMcp = useCallback(() => {
    const shell = (globalThis as unknown as { shell?: ShellBridge }).shell;
    void shell?.mcp
      ?.list?.()
      .then((r) => setMcp(r ?? null))
      .catch(() => setMcp(null));
  }, []);

  /* 进「连接器」页签时才拉（它是主进程的状态，没必要一直挂着） */
  useEffect(() => {
    if (mode !== "manage" || manageTab !== "连接器") return;
    pullMcp();
  }, [mode, manageTab, pullMcp]);

  /*
   * ── 外部插件（Phase 8.4）──
   *
   * 与上面的「已安装清单」**不是同一类东西**（与连接器同一条区分）：
   * 那些是应用内置目录里的条目（本应用自己长出来的能力），
   * 这些是**用户装的第三方代码**（装在 `userData/plugins/`，与宿主同进程跑）。
   *
   * 所以这一段的界面重点不是"好不好看"，而是**把两件事如实说清**：
   *   ① 它申请了什么权限、你批了哪几项（申请了没批的**真的不生效**）；
   *   ② 哪些权限 v1 根本拦不住（资源类）—— 那是"知情"不是"限制"。
   * 一个看着像权限、实际不生效的界面，比没有权限界面更坏。
   */
  const [plugins, setPlugins] = useState<
    | {
        name: string;
        version: string;
        description: string;
        enabled: boolean;
        granted: readonly string[];
        requested: readonly string[];
        withheld: readonly string[];
        declaredOnly: readonly string[];
        problems: string[];
        toolCount: number;
      }[]
    | null
  >(null);
  const [pluginNote, showPluginNote] = useTransientNote(3000);
  /** 有插件动作在跑（P48）：它决定安装键禁不禁用。 */
  const [pluginBusy, setPluginBusy] = useState(false);
  /** 同一帧里的第二次点击靠这个拦（state 还没来得及更新）。 */
  const pluginBusyRef = useRef(false);
  /** npm 包名输入（"发现"那一半：在 npm 上找到包名，粘进来装）。 */
  const [npmSpec, setNpmSpec] = useState("");

  const pullPlugins = useCallback(() => {
    const shell = (globalThis as unknown as { shell?: ShellBridge }).shell;
    void shell?.plugins
      ?.list?.()
      .then((r) => setPlugins(r ?? []))
      .catch(() => setPlugins([]));
  }, []);

  useEffect(() => {
    if (mode !== "manage" || manageTab !== "插件") return;
    pullPlugins();
  }, [mode, manageTab, pullPlugins]);

  /**
   * 本机库写盘失败的提示要**说出来**（2026-10-16 审计 P262）。
   *
   * `libraryStore` 把失败写进 `note`（"改动已生效，但存盘失败（重启后可能丢失）"），
   * 盯着这一条的判据是 `sweepTailStore.test.ts`（"本机库的 note 有人读了"那条）。
   * 而全仓**没有任何组件读过它** —— 用户点了启用/置顶，盘上却没写下去，
   * 界面上一点迹象都没有，重启之后才发现"我明明设过"。这里把它接到插件页已有的提示条上
   * （插件/技能/伙伴这一页正是管理那个库的地方）。
   */
  const libNote = useLibraryStore((s) => s.note);
  useEffect(() => {
    if (libNote) showPluginNote(libNote);
  }, [libNote, showPluginNote]);

  /**
   * 取插件通道（2026-10-16 审计 P10）。
   *
   * ⚠️ 调用点原来是 `shell!.plugins.install(...)` —— **非空断言**。没有桥的环境
   * （纯浏览器 / vite 直开）里 `shell` 是 undefined，`shell!.plugins` 直接抛
   * **TypeError**：点一下安装，界面什么都不发生、控制台一条红 —— 用户以为坏了，
   * 而真正的原因（根本不在 Electron 里）一个字都没说。
   * 现在如实说一句再返回 null（调用方 `if (!api) return;`）。
   */
  const pluginsApi = useCallback((): NonNullable<ShellBridge["plugins"]> | null => {
    const shell = (globalThis as unknown as { shell?: ShellBridge }).shell;
    if (!shell?.plugins) {
      showPluginNote("插件通道不可用：当前不在 Electron 里运行（用 pnpm dev:app 启动）");
      return null;
    }
    return shell.plugins;
  }, [showPluginNote]);

  /** 一次插件动作（安装/开关/卸载）：把结果里的清单接回来，失败的把原话显示出来。 */
  const doPluginAction = useCallback(
    (run: () => Promise<{ ok: boolean; errors?: string[]; list?: unknown }>, okNote: string) => {
      /*
       * ⚠️ **一次只跑一个插件动作**（2026-10-16 审计 P48）。
       *
       * 装插件在主进程是**真的执行用户代码**（`plugins.install` 会把它加载起来），
       * 而两颗安装键原来都是裸 `onClick` —— 连点两下就装两遍、执行两遍。
       * 判据用 ref：`setState` 要等下一次渲染，拦不住同一帧里的第二次点击。
       */
      if (pluginBusyRef.current) return;
      pluginBusyRef.current = true;
      setPluginBusy(true);
      void run()
        .then((r) => {
          if (!r.ok) {
            showPluginNote((r.errors ?? ["没成功"]).join("；"));
            return;
          }
          if (Array.isArray(r.list)) setPlugins(r.list as never);
          showPluginNote(okNote);

        })
        .catch((e: unknown) => showPluginNote(String(e).slice(0, 120)))
        .finally(() => {
          pluginBusyRef.current = false;
          setPluginBusy(false);
        });
    },
    [],
  );

  /*
   * 「添加」本机版的诚实对应物：**自己写一条能力**。
   * 本机版没有插件市场后端，所以让能力清单可扩展的路子是"用户自己写"，
   * 而不是假装能装一个远端插件。
   */
  const [addOpen, setAddOpen] = useState(false);
  const [addName, setAddName] = useState("");
  const [addHint, setAddHint] = useState("");
  const [addType, setAddType] = useState<"plugin" | "skill">("skill");
  const [addError, setAddError] = useState("");
  const addCustomItem = useLibraryStore((s) => s.addCustomItem);
  const lib = useLibraryStore((s) => s.lib);

  /*
   * 技能搜索（§160）：**先按匹配程度排，再丢掉空分组** ——
   * 留着空分组会让人以为"这个分类里什么都没有"，而不是"这一搜什么都没有"。
   */
  const filteredSkillGroups = SKILL_GROUPS.map(({ group, items }) => ({
    group,
    items: searchItems(items, skillQuery, (i) => i.name),
  })).filter((g) => g.items.length > 0);
  const skillEmpty = tab === "技能" && filteredSkillGroups.length === 0;

  const installedSet = new Set(installed);
  const enabledSet = new Set(enabled);
  /*
   * 必须用 `findItemIn` 而不是 `findItem`：自定义条目不在内置目录里，
   * 只查目录的话它们在这一页**看不见、计数也不对** ——
   * 同一个查询在"输入区"和"这一页"两处各写一遍，就会出现这种一半对一半错
   * （§49 与 §43 都是同一类）。所以两处都用同一个函数。
   */
  const installedItems = installed
    .map((id) => {
      const found = findItemIn(lib, id);
      if (!found) return null;
      return {
        id,
        name: found.name,
        hint: found.hint,
        type: found.type,
        // 目录条目有使用量，自己加的没有 —— 如实写"手动添加"，不编一个数
        users: (found as Partial<CatalogItem>).users ?? "手动添加",
      };
    })
    .filter((x): x is { id: string; name: string; hint: string; type: "plugin" | "skill"; users: string } =>
      Boolean(x),
    );
  const manageCounts = {
    插件: installedItems.filter((i) => i.type === "plugin").length,
    技能: installedItems.filter((i) => i.type === "skill").length,
    连接器: 0,
  };

  if (mode === "manage") {
    const listed = installedItems.filter((item) =>
      manageTab === "连接器" ? false : manageTab === "技能" ? item.type === "skill" : item.type === "plugin",
    );
    return (
      <section className="wb-page" data-testid="wb-page-plugins-manage">
        <header className="wb-page-head">
          <span className="wb-crumb">
            <button className="wb-crumb-link" data-testid="wb-crumb-market" onClick={() => setMode("market")}>
              市场
            </button>
            <span className="wb-crumb-sep">›</span>
            <b>管理</b>
          </span>
          <span className="wb-spacer" />
          <div className="wb-search">
            <Search size={13} />
            <span>搜索{manageTab}</span>
          </div>
          <button className="wb-page-btn" data-testid="wb-manage-add" onClick={() => setMode("market")}>
            <Plus size={14} /> 添加
          </button>
          {/*
            刷新：原来是个**没有 onClick 的死按钮**（§124 审计报出）。
            这里用 store 的 getState() 直接调 —— 不必为一个按钮改这个组件的解构。
          */}
          <button
            className="wb-icon"
            title="刷新"
            data-testid="wb-manage-refresh"
            onClick={() => void useLibraryStore.getState().load()}
          >
            ⟳
          </button>
        </header>

        <div className="wb-page-body">
          <div className="wb-tabs wb-manage-tabs" data-testid="wb-manage-tabs">
            {(["插件", "技能", "连接器"] as const).map((t) => (
              <button
                key={t}
                className={`wb-tab wb-manage-tab${manageTab === t ? " is-on" : ""}`}
                data-testid={`wb-manage-tab-${t}`}
                onClick={() => setManageTab(t)}
              >
                {t} <em>{manageCounts[t]}</em>
              </button>
            ))}
          </div>

          {manageTab === "连接器" ? (
            /*
             * 连接器（MCP）——**与上面的"已安装清单"不是同一类东西**：
             * 那些是应用内置目录里的条目，这些是用户配的外部进程。
             */
            <div className="wb-mcp" data-testid="wb-mcp">
              {(mcp?.servers ?? []).length === 0 ? (
                /*
                 * 空态**沿用原来那个 testid**（`wb-manage-empty`）：它就是"管理页的空态"，
                 * 只是文案从"本机版不含连接器体系"换成了**该怎么做**。
                 * 另起一个 testid 会让"这条页签有没有空态说明"这类既有断言白红一次 ——
                 * 而它们要证的其实是同一件事。
                 */
                <div className="wb-manage-empty" data-testid="wb-manage-empty">
                  {mcp?.empty ?? "还没有连接器"}
                </div>
              ) : (
                (mcp?.servers ?? []).map((srv) => (
                  <div className="wb-mcp-item" key={srv.name} data-testid={`wb-mcp-${srv.name}`}>
                    <div className="wb-sched-item-main">
                      <b>{srv.name}</b>
                      <em>{[srv.command, ...srv.args].join(" ")}</em>
                      <span className="wb-sched-meta" data-testid={`wb-mcp-line-${srv.name}`}>
                        {srv.line}
                      </span>
                      {srv.status !== "on" && srv.error ? (
                        /* 连不上要说清为什么 —— 一片空白等于让人去猜 */
                        <span className="wb-mcp-error" data-testid={`wb-mcp-error-${srv.name}`}>
                          {srv.error}
                        </span>
                      ) : null}
                      {srv.tools.length ? (
                        <span className="wb-mcp-tools" data-testid={`wb-mcp-tools-${srv.name}`}>
                          {srv.tools.map((t) => t.localName).join("、")}
                        </span>
                      ) : null}
                    </div>
                  </div>
                ))
              )}
              <div className="wb-mcp-actions">
                <button
                  className="wb-page-btn"
                  data-testid="wb-mcp-open-config"
                  onClick={() => {
                    const shell = (globalThis as unknown as { shell?: ShellBridge }).shell;
                    void shell?.mcp?.openConfig?.().then((r) => {
                      if (r && !r.ok) showMcpNote(`打不开配置文件：${r.error}`);
                    });
                  }}
                >
                  {MCP_LABELS.openConfig}
                </button>
                <button
                  className="wb-page-btn"
                  data-testid="wb-mcp-reload"
                  onClick={() => {
                    const shell = (globalThis as unknown as { shell?: ShellBridge }).shell;
                    void shell?.mcp?.reload?.().then(() => {
                      pullMcp();
                      showMcpNote("已重新连接");

                    });
                  }}
                >
                  {MCP_LABELS.reload}
                </button>
                {mcpNote ? (
                  <span className="wb-cloud-note" data-testid="wb-mcp-note">
                    {mcpNote}
                  </span>
                ) : null}
              </div>
              {mcp?.file ? (
                <div className="wb-mcp-file" data-testid="wb-mcp-file">
                  配置文件：{mcp.file}
                </div>
              ) : null}
            </div>
          ) : (
            <>
            {/*
              「插件」页签**两段都要在**：外部插件段在前、原来的「已安装清单」在后。
              ⚠️ 顺序有理由（外部插件是用户自己装的东西，他进这一页多半为了管它们；
              内置清单更稳定），但**两段都必须在** —— 第一版把清单整段挤掉了，
              而验收脚本当场就报"插件 tab 里没有刚装的那个"（`accept-context`）。
              所以这里用 `manageTab === "插件" ? 段 : null` 叠在原有结构**之上**，
              而不是替换掉它。
            */}
            {manageTab === "插件" ? (
            <div className="wb-plugin-ext" data-testid="wb-plugin-ext">
              <div className="wb-plugin-ext-head">
                <b>外部插件</b>
                <span className="wb-sched-meta">
                  {plugins === null ? "读取中…" : plugins.length ? `${plugins.length} 个` : "还没有"}
                </span>
                <span className="wb-spacer" />
                {/*
                  两条件装路径（Phase 8.4 的"发现 + 安装"）：
                  · 本地目录 —— 走系统对话框（目录由对话框给，渲染层不传路径）；
                  · npm 包 —— 输入包名（主进程会**严格校验**：包名不是路径）。
                  "发现"在 v1 就是**在 npm 上找包**（方案定的主渠道），所以这里给一个输入框，
                  而不是假装有一个我们并不运营的市场后端。
                */}
                <input
                  className="wb-setpage-input"
                  data-testid="wb-plugin-npm"
                  placeholder="npm 包名（可带 @版本）"
                  value={npmSpec}
                  onChange={(e) => setNpmSpec(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key !== "Enter" || !npmSpec.trim()) return;
                    const api = pluginsApi();
                    if (!api) return;
                    doPluginAction(() => api.install(npmSpec.trim()), "装好了");
                    setNpmSpec("");
                  }}
                />
                <button
                  className="wb-page-btn"
                  data-testid="wb-plugin-install-npm"
                  disabled={!npmSpec.trim() || pluginBusy}
                  onClick={() => {
                    const api = pluginsApi();
                    if (!api) return;
                    doPluginAction(() => api.install(npmSpec.trim()), "装好了");
                    setNpmSpec("");
                  }}
                >
                  装 npm 包
                </button>
                <button
                  className="wb-page-btn"
                  data-testid="wb-plugin-install"
                  disabled={pluginBusy}
                  onClick={() => {
                    const api = pluginsApi();
                    if (!api) return;
                    doPluginAction(() => api.install(), "装好了");
                  }}
                >
                  <Plus size={14} /> 从目录安装
                </button>
              </div>

              {plugins === null ? null : plugins.length === 0 ? (
                <div className="wb-manage-empty" data-testid="wb-plugin-empty">
                  还没有装外部插件。点「从目录安装」选一个插件目录（要有 ding-plugin.json 或带 ding 字段的 package.json）。
                </div>
              ) : (
                <div className="wb-sched-list">
                  {plugins.map((p) => (
                    <div className="wb-sched-item" key={p.name} data-testid={`wb-plugin-${p.name}`}>
                      <div className="wb-sched-item-main">
                        <b>
                          {p.name}
                          <em>@{p.version}</em>
                        </b>
                        <em>{p.description}</em>
                        <span className="wb-sched-meta" data-testid={`wb-plugin-state-${p.name}`}>
                          {p.enabled ? "开着" : "关着"} · 接上 {p.toolCount} 个工具
                        </span>
                        <span className="wb-sched-meta" data-testid={`wb-plugin-perms-${p.name}`}>
                          {p.granted.length ? `已批权限：${p.granted.join(" / ")}` : "没有批任何权限"}
                        </span>
                        {p.withheld.length ? (
                          <span className="wb-cloud-note" data-testid={`wb-plugin-withheld-${p.name}`}>
                            申请了但没批（**真的不生效**）：{p.withheld.join(" / ")}
                          </span>
                        ) : null}
                        {p.declaredOnly.length ? (
                          <span className="wb-sched-meta" data-testid={`wb-plugin-declared-${p.name}`}>
                            v1 拦不住（只是声明）：{p.declaredOnly.join(" / ")}
                          </span>
                        ) : null}
                        {p.problems.map((problem) => (
                          <span className="wb-mcp-error" key={problem} data-testid={`wb-plugin-problem-${p.name}`}>
                            {problem}
                          </span>
                        ))}
                      </div>
                      <button
                        className="wb-page-btn"
                        data-testid={`wb-plugin-toggle-${p.name}`}
                        onClick={() => {
                          const api = pluginsApi();
                          if (!api) return;
                          doPluginAction(() => api.setEnabled(p.name, !p.enabled), p.enabled ? "已关掉" : "已打开");
                        }}
                      >
                        {p.enabled ? "关掉" : "打开"}
                      </button>
                      <button
                        className="wb-page-btn"
                        data-testid={`wb-plugin-remove-${p.name}`}
                        onClick={() => {
                          const api = pluginsApi();
                          if (!api) return;
                          doPluginAction(() => api.uninstall(p.name), "卸载了");
                        }}
                      >
                        卸载
                      </button>
                    </div>
                  ))}
                </div>
              )}
              {pluginNote ? (
                <div className="wb-cloud-note" data-testid="wb-plugin-note">
                  {pluginNote}
                </div>
              ) : null}
            </div>
            ) : null}

            {listed.length === 0 ? (
              <div className="wb-manage-empty" data-testid="wb-manage-empty">
                {`你还没有添加${manageTab}`}
              </div>
            ) : (
              <div className="wb-sched-list">
              {listed.map((item) => (
                <div className="wb-sched-item" key={item.id} data-testid={`wb-managed-${item.id}`}>
                  <div className="wb-sched-item-main">
                    <b>{item.name}</b>
                    <em>{item.hint}</em>
                    <span className="wb-sched-meta">
                      {item.users}
                      {enabledSet.has(item.id) ? " · 已启用" : ""}
                    </span>
                  </div>
                  <button className="wb-page-btn" data-testid={`wb-remove-${item.id}`} onClick={() => install(item.id)}>
                    移除
                  </button>
                </div>
                ))}
              </div>
            )}
            </>
          )}
        </div>
      </section>
    );
  }

  return (
    <section className="wb-page" data-testid="wb-page-plugins">
      <header className="wb-page-head">
<NavCollapseButton />
        <div className="wb-tabs" data-testid="wb-plugin-tabs">
          {ADMIN_TABS.map((t) => (
            <button
              key={t}
              className={`wb-tab${tab === t ? " is-on" : ""}`}
              data-testid={`wb-plugin-tab-${t}`}
              onClick={() => setTab(t)}
            >
              {t}
            </button>
          ))}
        </div>
        <span className="wb-spacer" />
        <span className="wb-cloud-count" data-testid="wb-installed-count">
          已安装 {installed.length} 个
          {enabled.length > 0 ? ` · 启用 ${enabled.length} 个` : ""}
        </span>
        <div className="wb-search">
          <Search size={13} />
          <span>搜索{tab}</span>
        </div>
        <button
          className="wb-page-btn"
          data-testid="wb-plugin-manage"
          onClick={() => {
            /*
             * 进「管理」时**回到默认 tab**。
             * 不重置的话会记住上次停在哪个 tab —— 如果上次停在「连接器」，
             * 而本机版没有连接器体系，用户一进来看到的就是一个空页，像坏了。
             */
            setManageTab("插件");
            setMode("manage");
          }}
        >
          <Settings2 size={13} /> 管理
        </button>
        <button
          className="wb-page-btn"
          data-testid="wb-plugin-add"
          onClick={() => {
            setAddOpen((v) => !v);
            setAddError("");
          }}
        >
          <Plus size={14} /> 添加
        </button>
      </header>

      <div className="wb-page-body">
        <label className="wb-searchbox" data-testid="wb-plugin-searchbox">
          <Search size={13} />
          <input
            data-testid="wb-plugins-search"
            value={skillQuery}
            placeholder={placeholderFor("skills")}
            onChange={(e) => setSkillQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") commitSkillQuery();
            }}
            onBlur={() => commitSkillQuery()}
          />
          {/*
            「清除」（§160 补全，2026-10-14）：原来输入框里没有 ×，
            用户要"不搜了"只能全选删掉 —— 而搜索框旁边空出一大片。
            只在有内容时出现（空的时候摆一颗 × 是没有意义的）。
          */}
          {skillQuery ? (
            <button
              className="wb-search-x"
              type="button"
              aria-label={SEARCH_LABELS.clear}
              title={SEARCH_LABELS.clear}
              data-testid="wb-plugins-search-clear"
              onClick={() => {
                setSkillQuery("");
                commitSkillQuery("");
              }}
            >
              <X size={12} />
            </button>
          ) : null}
        </label>
        {/*
          命中计数：搜索完只看到结果变少，**不知道筛掉了多少** ——
          有个数字就不会怀疑"目录本身少了几条"。
          和空态一样只在**技能**栏显示：别的栏里结果根本不渲染，
          摆一个够不着的数字只会让人以为"筛没了"。
        */}
        {tab === "技能" && skillQuery.trim() ? (
          <div className="wb-search-hits" data-testid="wb-plugins-hits">
            {hitLabel(filteredSkillGroups.reduce((n, g) => n + g.items.length, 0))}
          </div>
        ) : null}
        {skillQuery ? null : <SearchHistoryStrip scope="skills" onPick={setSkillQuery} />}
        <div className="wb-chips" data-testid="wb-plugin-categories">
          {PLUGIN_CATEGORIES.map((c) => (
            <button key={c} className={`wb-cat${category === c ? " is-on" : ""}`} onClick={() => setCategory(c)}>
              {c}
            </button>
          ))}
          <button className="wb-cat">
            更多 <ChevronDown size={12} />
          </button>
        </div>

        {tab === "技能" ? (
          <>
            {filteredSkillGroups.map(({ group, items }) => (
              <div key={group}>
                <div className="wb-group-title">
                  {group} <ChevronRight />
                </div>
                <div className="wb-plugin-grid">
                  {items.map((item) => (
                    <PluginCard
                      key={item.id}
                      item={item}
                      installed={installedSet.has(item.id)}
                      enabled={enabledSet.has(item.id)}
                      onInstall={() => install(item.id)}
                      onEnable={() => enable(item.id)}
                    />
                  ))}
                </div>
              </div>
            ))}
            {/*
              搜不到时说清"是这一搜没有"（`search_skills_empty_info` = 无匹配的技能），
              而不是留一片空白让人以为页面坏了。
            */}
            {skillEmpty ? (
              <div className="wb-search-empty" data-testid="wb-plugins-empty">
                <p>{SEARCH_LABELS.skillsEmpty}</p>
                {/*
                  空态**必须给出路**：原来只有这一句说明，用户唯一的办法是自己把字删掉。
                  （本项目的纪律：拦下就要给出路 —— 见 `ToolTraceList` 那段自述。）
                */}
                {skillQuery.trim() ? (
                  <button
                    className="wb-page-btn"
                    type="button"
                    data-testid="wb-plugins-empty-clear"
                    onClick={() => {
                      setSkillQuery("");
                      commitSkillQuery("");
                    }}
                  >
                    {SEARCH_LABELS.clearFilter}
                  </button>
                ) : null}
              </div>
            ) : null}
          </>
        ) : (
          <>
        {addOpen ? (
          <div className="wb-addform" data-testid="wb-add-form">
            <div className="wb-addform-row">
              <select
                className="wb-sched-select"
                data-testid="wb-add-type"
                value={addType}
                onChange={(e) => setAddType(e.target.value as "plugin" | "skill")}
              >
                <option value="skill">技能</option>
                <option value="plugin">插件</option>
              </select>
              <input
                className="wb-sched-input"
                placeholder="名字"
                data-testid="wb-add-name"
                value={addName}
                onChange={(e) => setAddName(e.target.value)}
              />
            </div>
            <input
              className="wb-sched-input"
              placeholder="一句话说明它干什么 —— 这句会进任务的提示词，写清楚点"
              data-testid="wb-add-hint"
              value={addHint}
              onChange={(e) => setAddHint(e.target.value)}
            />
            <div className="wb-addform-foot">
              {addError ? (
                <em className="wb-addform-err" data-testid="wb-add-error">
                  {addError}
                </em>
              ) : (
                <em className="wb-addform-tip">加完会自动装上并启用，可直接在任务里用</em>
              )}
              <span className="wb-spacer" />
              <button className="wb-page-btn" data-testid="wb-add-cancel" onClick={() => setAddOpen(false)}>
                取消
              </button>
              <button
                className="wb-page-btn wb-page-btn-primary"
                data-testid="wb-add-save"
                onClick={() => {
                  const error = addCustomItem(addName, addHint, addType);
                  setAddError(error ?? "");
                  if (!error) {
                    setAddName("");
                    setAddHint("");
                    setAddOpen(false);
                  }
                }}
              >
                <Check size={13} /> 添加并启用
              </button>
            </div>
          </div>
        ) : null}

            <div className="wb-featured">
              {FEATURED_ITEMS.map((item) => {
                /* 大卡右侧那块也一样：原来是空渐变块（体检同一处发现的）。 */
                const FeatureIcon = catalogIcon(item);
                return (
                  <div className="wb-feature-card" key={item.id}>
                    <span className="wb-feature-text">
                      <em>必备精选</em>
                      <b>{item.name}</b>
                      <span>{item.hint}</span>
                    </span>
                    <span className="wb-feature-art" aria-hidden>
                      <FeatureIcon size={22} />
                    </span>
                    <button
                      className={`wb-install${installedSet.has(item.id) ? " is-done" : ""}`}
                      data-testid={`wb-install-${item.id}`}
                      onClick={() => install(item.id)}
                    >
                      {installedSet.has(item.id) ? "已安装" : "安装"}
                    </button>
                  </div>
                );
              })}
            </div>

            <div className="wb-page-label">特别推荐</div>
            <div className="wb-plugin-grid">
              {RECOMMENDED_PLUGINS.map((item) => (
                <PluginCard
                  key={item.id}
                  item={item}
                  installed={installedSet.has(item.id)}
                  enabled={enabledSet.has(item.id)}
                  onInstall={() => install(item.id)}
                  onEnable={() => enable(item.id)}
                />
              ))}
            </div>
          </>
        )}
      </div>
    </section>
  );
}

