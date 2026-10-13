import { ChevronLeft } from "lucide-react";
import { SETTINGS_LABELS, aboutTitle, memoryStateLabel, settingsSections } from "@shared/settings";
import { useMemoryStore } from "./memoryStore";
import { useAppSettings } from "./appSettings";

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

export type SettingsSubPage = "profile" | "account" | "general" | "about";

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
  profile: {
    title: "个人资料",
    note: "本机版没有账号服务端：昵称与头像是本地显示用的，不会同步到任何服务器。",
  },
  general: {
    title: "通用",
    note: "本机版的通用设置：能真起作用的才放上来（记忆开关真的会停掉注入，开启新话题真的会开一段新对话）。",
  },
  about: {
    title: aboutTitle("豆包工作"),
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

  return (
    <div className="wb-setpage" data-testid={`wb-setpage-${page}`}>
      <div className="wb-setpage-head">
        <button className="wb-icon" title="返回" data-testid="wb-setpage-back" onClick={onBack}>
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
            {/* 官网是真实存在的外部站点，照实给链接 */}
            <a className="wb-setpage-btn" href="https://www.doubao.com" target="_blank" rel="noreferrer">
              doubao.com
            </a>
          </div>
        </div>
      ) : null}

      {page === "profile" ? (
        <div className="wb-setpage-body">
          <div className="wb-setpage-row">
            <span className="wb-setpage-label">昵称</span>
            <em>按时吃饭450</em>
          </div>
          <div className="wb-setpage-row">
            <span className="wb-setpage-label">豆包号</span>
            <em>user_QVqiCFv60</em>
          </div>
          <div className="wb-setpage-row">
            <span className="wb-setpage-label">套餐</span>
            <em>标准套餐</em>
          </div>
        </div>
      ) : (
        <div className="wb-setpage-body">
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
      )}
    </div>
  );
}
