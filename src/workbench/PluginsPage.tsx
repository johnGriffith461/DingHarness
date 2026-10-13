/**
 * 从 `pages.tsx` 拆出来的（C6-2）。**纯挪位**：一个字没改，只加了 export 与 import。
 * 拆分理由见 `docs/PLAN-C6-结构拆分.md`（那个文件 1669 行 / 7 个顶层组件）。
 */

import { useEffect, useState } from "react";
import { SEARCH_LABELS, placeholderFor, searchItems } from "@shared/search";
import { SearchHistoryStrip } from "./SearchHistoryStrip";
import { useSearchHistoryStore } from "./searchHistoryStore";
import { Check, ChevronDown, List, Plus, Search, Settings2 } from "lucide-react";
import { ADMIN_TABS } from "./copy";
import { FEATURED_ITEMS, RECOMMENDED_PLUGINS, SKILL_GROUPS, type CatalogItem } from "./catalog";
import { findItemIn, useLibraryStore } from "./libraryStore";
import { useWorkbenchStore } from "./store";

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
  /** 什么时候算"搜过一次"：按回车、或离开输入框时（**不是每敲一个字都记**）。 */
  const commitSkillQuery = (): void => {
    if (skillQuery.trim()) recordSearch("skills", skillQuery);
  };
  /** 管理页的三 tab：插件 / 技能 / **连接器**（与市场页的「工作伙伴」不同）。 */
  const [manageTab, setManageTab] = useState<"插件" | "技能" | "连接器">("插件");

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

          {listed.length === 0 ? (
            <div className="wb-manage-empty" data-testid="wb-manage-empty">
              {manageTab === "连接器" ? "还没有添加连接器（本机版不含连接器体系）" : `你还没有添加${manageTab}`}
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
        </div>
      </section>
    );
  }

  return (
    <section className="wb-page" data-testid="wb-page-plugins">
      <header className="wb-page-head">
        {/* 侧栏折叠：本机版还没做（参考实现里有）—— 标 disabled，不装作能用（§125/§126） */}
<button className="wb-icon" aria-label="打开/收起左侧栏" title="打开/收起左侧栏（本机版还没做折叠）" disabled>
          <List size={15} />
        </button>
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
            onBlur={commitSkillQuery}
          />
        </label>
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
              <p className="wb-search-empty" data-testid="wb-plugins-empty">
                {SEARCH_LABELS.skillsEmpty}
              </p>
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
              {FEATURED_ITEMS.map((item) => (
                <div className="wb-feature-card" key={item.id}>
                  <span className="wb-feature-text">
                    <em>必备精选</em>
                    <b>{item.name}</b>
                    <span>{item.hint}</span>
                  </span>
                  <span className="wb-feature-art" />
                  <button
                    className={`wb-install${installedSet.has(item.id) ? " is-done" : ""}`}
                    data-testid={`wb-install-${item.id}`}
                    onClick={() => install(item.id)}
                  >
                    {installedSet.has(item.id) ? "已安装" : "安装"}
                  </button>
                </div>
              ))}
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

