import { useEffect, useRef, useState } from "react";
import {
  Check,
  ChevronRight,
  CircleHelp,
  Folder,
  Globe,
  LogOut,
  Monitor,
  Moon,
  RefreshCw,
  Settings as SettingsIcon,
  Sun,
  UserPlus,
} from "lucide-react";

import { readTheme, saveTheme, THEME_OPTIONS, type Theme } from "./theme";

/**
 * 账号菜单。
 *
 * 结构对齐本体（豆包工作）账号头像点开后的菜单：
 *   设置 / 外观设置▸ / 收藏夹 / 豆包工作官网 / 检查更新 / 帮助与反馈 /
 *   当前时段额度用量 / 添加账号 / 退出登录
 *
 * 「外观设置」是**子菜单三选一**（跟随系统 / 浅色模式 / 深色模式），
 * 当前项带勾 —— 不是"点一下切换"的布尔开关。
 *
 * 没有后端支撑的项（官网 / 检查更新 / 帮助与反馈 / 额度用量 / 添加账号 / 退出登录）
 * **如实**呈现，不装作能用。
 */

/** 三档各自的图标，与本体子菜单一致（跟随系统=显示器、浅色=日、深色=月）。 */
const THEME_ICON: Record<Theme, typeof Monitor> = {
  system: Monitor,
  light: Sun,
  dark: Moon,
};

export type AccountMenuProps = {
  /** 关闭菜单。 */
  onClose: () => void;
  /** 打开设置弹窗（设置项的动作）。 */
  onOpenSettings: () => void;
  /** 打开收藏夹（星标文件）。 */
  onOpenStarred?: () => void;
};

/*
 * ⚠️ 下面五项（官网 / 检查更新 / 帮助与反馈 / 添加账号 / 退出登录）是 **disabled** 的 ——
 * 不是漏接线，是本机版**没有对应的后端**。
 *
 * 判据来自本项目的标准"如实呈现，不装作能用"：
 * 一个点了什么都不发生的按钮，**必须在视觉上也表明不可用**，
 * 否则就是用户报的那种"点了没反应"。
 *
 * 启动器的更新链路做完之后（PLAN 的 R3 档次二），「检查更新」才该变回可点。
 */
export default function AccountMenu({ onClose, onOpenSettings, onOpenStarred }: AccountMenuProps) {
  const [theme, setTheme] = useState<Theme>(() => readTheme());
  const [submenuOpen, setSubmenuOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  // 点外面 / 按 Esc 关掉 —— 菜单该有的基本行为
  useEffect(() => {
    const onDown = (e: MouseEvent): void => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  /**
   * 选一档外观设置。
   *
   * `saveTheme` 会立刻应用 —— 所以点完就能看到变化，不用重开菜单。
   *
   * @param next 要选的档位
   */
  const pick = (next: Theme): void => {
    saveTheme(next);
    setTheme(next);
    setSubmenuOpen(false);
  };

  const item = "wb-acct-item";

  return (
    <div className="wb-acct-menu" ref={rootRef} data-testid="wb-account-menu">
      <button className={item} data-testid="wb-acct-settings" onClick={() => { onOpenSettings(); onClose(); }}>
        <SettingsIcon size={15} />
        <span>设置</span>
      </button>

      {/* 「外观设置」是子菜单的父项，本身不执行动作 */}
      <button
        className={`${item}${submenuOpen ? " is-open" : ""}`}
        data-testid="wb-acct-appearance"
        onClick={() => setSubmenuOpen((v) => !v)}
      >
        <Monitor size={15} />
        <span>外观设置</span>
        <ChevronRight size={14} className="wb-acct-chevron" />
      </button>

      {submenuOpen ? (
        <div className="wb-acct-sub" data-testid="wb-acct-theme-sub">
          {THEME_OPTIONS.map((opt) => {
            const Icon = THEME_ICON[opt.value];
            return (
              <button
                key={opt.value}
                className={`${item} is-sub`}
                data-testid={`wb-acct-theme-${opt.value}`}
                onClick={() => pick(opt.value)}
              >
                <Icon size={15} />
                <span>{opt.label}</span>
                {theme === opt.value ? <Check size={15} className="wb-acct-check" /> : null}
              </button>
            );
          })}
        </div>
      ) : null}

      <button className={item} data-testid="wb-acct-starred" onClick={() => { onOpenStarred?.(); onClose(); }}>
        <Folder size={15} />
        <span>收藏夹</span>
      </button>

      <div className="wb-acct-sep" />

      <button className={item} disabled data-testid="wb-acct-site" title="本机版没有跳转目标">
        <Globe size={15} />
        <span>Dingwork 官网</span>
      </button>

      <button className={item} disabled data-testid="wb-acct-update" title="本机版没有更新服务端">
        <RefreshCw size={15} />
        <span>检查更新</span>
      </button>

      <button className={item} disabled data-testid="wb-acct-help" title="本机版没有反馈通道">
        <CircleHelp size={15} />
        <span>帮助与反馈</span>
      </button>

      <div className="wb-acct-sep" />

      {/* 额度用量：本机版按已用量算不出"时段额度"，所以只显示用量本身 */}
      <div className="wb-acct-quota" data-testid="wb-acct-quota">
        <span className="wb-acct-radio" />
        <span>当前时段额度用量</span>
        <em>—</em>
      </div>

      <button className={item} disabled data-testid="wb-acct-add" title="本机版没有账号服务端">
        <UserPlus size={15} />
        <span>添加账号</span>
      </button>

      <div className="wb-acct-sep" />

      <button className={item} disabled data-testid="wb-acct-logout" title="本机版没有登录态">
        <LogOut size={15} />
        <span>退出登录</span>
      </button>
    </div>
  );
}
