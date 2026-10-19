import { ChevronLeft } from "lucide-react";
import { SETTINGS_LABELS, aboutTitle, memoryStateLabel, settingsSections } from "@shared/settings";
import { ModelSettingsPage } from "./ModelSettingsPage";
import { TeamPage } from "./TeamPage";
import { PluginsPage } from "./PluginsPage";
import { KnowledgePage } from "./KnowledgePage";
import { PersonalizePanel } from "./PersonalizePanel";
import { ProjectRulesPanel } from "./ProjectRulesPanel";
import { LspPanel } from "./LspPanel";
import { useMemoryStore } from "./memoryStore";
import { useAppSettings } from "./appSettings";
import { spacing } from "../utils/spacing";

/**
 * 设置里的两个**子页**：个人资料 / 账号。
 *
 * 依据本体路由 `chat/settings/profile` 与 `chat/settings/account` ——
 * 它们是**独立页面**，而我把这两块内容混在设置弹窗的头部里（头像 + 名字 + 豆包号 + 按钮）。
 *
 * 本机版没有账号服务端，所以这里**如实呈现**：
 * 能改的（昵称）真能改；不能改的（豆包号、套餐、账号管理）**标明原因**，
 * 而不是画一个点了没反应的按钮。
 */

export type SettingsSubPage = "profile" | "account" | "general" | "about" | "models" | "plugins" | "team" | "knowledge";

export type SettingsPagesProps = {
  /** 显示哪一页。 */
  page: SettingsSubPage;
  /** 返回上一级。 */
  onBack: () => void;
  /** 「开启新话题」：真的开一段新对话（§182，`settings_clear_context_new`）。 */
  onNewTopic?: () => void;
  /** 当前钉住的默认模型（§183，空串 = 记忆上次）。 */
  pinned?: string;
  /** 可选的通道（§183）。 */
  choices?: Array<{ provider: string; model: string; label: string }>;
};

/** 两页各自的标题与说明。 */
const META: Record<SettingsSubPage, { title: string; note: string }> = {
  plugins: { title: "插件·技能·伙伴", note: "装了什么、启用了什么（原来在左栏，2026-10-16 搬进设置）" },
  team: {
    title: "团队空间",
    note: "名册 / 配对码 / 共享与接管 / 按成员的成本账本 —— 账本与 `ding space`、`ding serve` 是同一个文件。",
  },
  models: { title: "模型", note: "配哪些 provider、拉它们的模型清单、选默认模型" },
  knowledge: { title: "知识库", note: "导入资料 → 自己检索 → 回答带引用。与 ding knowledge 是同一个库文件。" },
  profile: {
    title: "个人资料",
    note: "本机版没有账号服务端：昵称与头像是本地显示用的，不会同步到任何服务器。",
  },
  general: {
    title: "通用",
    note: "本机版的通用设置：能真起作用的才放上来（记忆开关真的会停掉注入，开启新话题真的会开一段新对话）。",
  },
  about: {
    /*
     * 产品名 2026-10-14 从「豆包工作」换成 `Ding Harness` —— 拼接出来是 `关于Ding Harness`，
     * 中英之间缺空格。这里过仓库自己的 `spacing()`（对标原版 `pangu.spacing()`）：
     * 排版规则归它管，`aboutTitle` 保持"只拼接"的纯函数（它的单测也就一行不用动）。
     */
    title: spacing(aboutTitle("Ding Harness")),
    note: "本机版没有服务端，所以这里只说本机这一份的事实。",
  },
  account: {
    title: "账号",
    note: "本机版没有账号服务端：登录、切换账号、退出登录都需要服务器，这里只显示当前状态。",
  },
};

export default function SettingsPages({
  page,
  onBack,
  onNewTopic,
  pinned = "",
  choices = [],
}: SettingsPagesProps) {
  const meta = META[page];
  /** 记忆开关当前状态（从库里读真实值，不是本地 state）。 */
  const memoryOn = useMemoryStore((s) => s.lib.enabled !== false);
  /** C3：轻量模型（起标题 / 压缩用）。 */
  const liteModel = useAppSettings((s) => s.liteModel);

  /* 模型子页是独立一块（见 ModelSettingsPage 的说明）：整页交给它 */
  /* 插件·技能·伙伴：**整页搬进来**（内容仍是原来那个 PluginsPage，功能零改动） */
  if (page === "plugins") {
    return (
      <div className="wb-setpage" data-testid="wb-setpage-plugins">
        <header className="wb-setpage-head">
          <button className="wb-icon" data-testid="wb-setpage-back" onClick={onBack} aria-label="返回">‹</button>
          <b>插件·技能·伙伴</b>
        </header>
        <PluginsPage />
      </div>
    );
  }

  if (page === "team") {
    return (
      <div className="wb-setpage" data-testid="wb-setpage-team">
        <header className="wb-setpage-head">
          <button className="wb-icon" data-testid="wb-setpage-back" onClick={onBack} aria-label="返回">‹</button>
          <b>团队空间</b>
        </header>
        <TeamPage />
      </div>
    );
  }

  if (page === "knowledge") {
    return (
      <div className="wb-setpage" data-testid="wb-setpage-knowledge">
        <header className="wb-setpage-head">
          <button className="wb-icon" data-testid="wb-setpage-back" onClick={onBack} aria-label="返回">‹</button>
          <b>知识库</b>
        </header>
        <KnowledgePage />
      </div>
    );
  }

  if (page === "models") {
    return (
      <div className="wb-setpage" data-testid="wb-setpage-models">
        <header className="wb-setpage-head">
          <button className="wb-icon" data-testid="wb-setpage-back" onClick={onBack} aria-label="返回">‹</button>
          <b>模型</b>
        </header>
        <ModelSettingsPage />
      </div>
    );
  }

  return (
    <div className="wb-setpage" data-testid={`wb-setpage-${page}`}>
      <div className="wb-setpage-head">
        <button className="wb-icon" aria-label="返回" title="返回" data-testid="wb-setpage-back" onClick={onBack}>
          <ChevronLeft size={15} />
        </button>
        <span>{meta.title}</span>
      </div>

      <div className="wb-setpage-note">{meta.note}</div>

      {page === "general" ? (
        <div className="wb-setpage-body" data-testid="wb-setpage-general-body">
          {/* 分类导航（`settings_navigation` = 设置分类）：照实列出这一页有什么 */}
          <div className="wb-setpage-row">
            <span className="wb-setpage-label">{SETTINGS_LABELS.navigation}</span>
            <em>{settingsSections().map((s) => s.label).join(" / ")}</em>
          </div>
          {/*
            记忆开关（`settings_memory_on_off`）：**真有作用** ——
            关掉之后不再把记忆注入系统提示词（条目还在，随时开回来）。
          */}
          <div className="wb-setpage-row">
            <span className="wb-setpage-label">{SETTINGS_LABELS.memory}</span>
            <button
              className="wb-setpage-btn"
              data-testid="wb-setpage-memory"
              onClick={() => void useMemoryStore.getState().setEnabled(!memoryOn)}
            >
              {memoryStateLabel(memoryOn)}
            </button>
          </div>
          {/*
            新对话默认模型（`settings_defaultNewChatModel`）：
            `记忆上次`（默认）或钉一个具体模型。
            ⚠️ 它**只在新对话时生效** —— 不劫持正在进行的那段对话（理由写在 `pickRoute` 里）。
          */}
          <div className="wb-setpage-row">
            <span className="wb-setpage-label">{SETTINGS_LABELS.defaultModel}</span>
            <select
              className="wb-setpage-select"
              data-testid="wb-setpage-pinned"
              value={pinned}
              onChange={(e) => void useAppSettings.getState().setPinned(e.target.value)}
            >
              <option value="">{SETTINGS_LABELS.useLast}</option>
              {choices.map((c) => (
                <option key={`${c.provider}/${c.model}`} value={`${c.provider}/${c.model}`}>
                  {c.label}
                </option>
              ))}
            </select>
          </div>

          {/* C3：轻量模型（附属请求用；空 = 跟随主模型） */}
          <div className="wb-setpage-row">
            <span className="wb-setpage-label">轻量模型</span>
            <select
              className="wb-setpage-select"
              data-testid="wb-setpage-lite"
              value={liteModel}
              onChange={(e) => void useAppSettings.getState().setLiteModel(e.target.value)}
            >
              <option value="">跟随主模型</option>
              {choices.map((c) => (
                <option key={`lite-${c.provider}/${c.model}`} value={`${c.provider}/${c.model}`}>
                  {c.label}
                </option>
              ))}
            </select>
          </div>

          {/* 开启新话题（`settings_clear_context_new`）：真的开一段新对话 */}
          <div className="wb-setpage-row">
            <span className="wb-setpage-label">{SETTINGS_LABELS.newTopic}</span>
            <button
              className="wb-setpage-btn"
              data-testid="wb-setpage-newtopic"
              onClick={() => onNewTopic?.()}
            >
              {SETTINGS_LABELS.newTopic}
            </button>
          </div>

          {/* A1/A2：项目规则与环境（真的被读进第一轮系统提示词的那几个文件） */}
          <ProjectRulesPanel />

          {/* G6：LSP 语言服务器（编辑后只报新引入的 error） */}
          <LspPanel />

          {/* L06 个性化：主题 / 快捷键 / 助手人格（独立组件，见 PersonalizePanel 的说明） */}
          <PersonalizePanel />
        </div>
      ) : null}

      {page === "about" ? (
        <div className="wb-setpage-body" data-testid="wb-setpage-about-body">
          <div className="wb-setpage-row">
            <span className="wb-setpage-label">版本</span>
            <em>本机版</em>
          </div>
          <div className="wb-setpage-row">
            <span className="wb-setpage-label">{SETTINGS_LABELS.userPolicy}</span>
            <em>本机版不含账号体系，因此没有需要同意的协议</em>
          </div>
          <div className="wb-setpage-row">
            <span className="wb-setpage-label">{SETTINGS_LABELS.website}</span>
            {/* 本机版没有官网，指到项目仓库 */}
            <a className="wb-setpage-btn" href="https://github.com/johnGriffith461/DingHarness" target="_blank" rel="noreferrer">
              github.com/johnGriffith461/DingHarness
            </a>
          </div>
        </div>
      ) : null}

      {page === "profile" ? (
        <div className="wb-setpage-body">
          <div className="wb-setpage-row">
            <span className="wb-setpage-label">昵称</span>
            <em>本机用户</em>
          </div>
          <div className="wb-setpage-row">
            <span className="wb-setpage-label">账号</span>
            <em>本机模式</em>
          </div>
          <div className="wb-setpage-row">
            <span className="wb-setpage-label">授权</span>
            <em>本机（无订阅）</em>
          </div>
        </div>
      ) : null}

      {/*
        ⚠️ 2026-10-16（审计 P260）：这一段原来是**上一个三元式的 else 分支**
        （`page === "profile" ? 资料 : 账号`）—— 于是"通用"与"关于"这两种页
        都会在底下**再挂一整块账号内容**（同一个 `.wb-setpage-body` 渲染两遍：
        通用页在「设置分类/记忆/默认模型/新话题」后面追加「当前状态/可用的能力/依赖账号的功能」）。
        现在按页名精确匹配：只有 `account` 才渲染这一段。
      */}
      {page === "account" ? (
        <div className="wb-setpage-body" data-testid="wb-setpage-account-body">
          <div className="wb-setpage-row">
            <span className="wb-setpage-label">当前状态</span>
            <em>本机模式（未登录）</em>
          </div>
          <div className="wb-setpage-row">
            <span className="wb-setpage-label">可用的能力</span>
            <em>发消息、出产物、画布、定时任务 —— 都由本机提供</em>
          </div>
          <div className="wb-setpage-row">
            <span className="wb-setpage-label">依赖账号的功能</span>
            <em>订阅与额度、记忆云端同步、插件市场、手机遥控配对</em>
          </div>
        </div>
      ) : null}
    </div>
  );
}
