import { useEffect, useRef, useState } from "react";
import {
  Check,
  ChevronRight,
  Folder,
  Monitor,
  Moon,
  Settings as SettingsIcon,
  Sun,
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
 * ⚠️ 原来这里还有五项：官网 / 检查更新 / 帮助与反馈 / 添加账号 / 退出登录 ——
 * 全是 `disabled` + 一句"本机版没有对应后端"。
 *
 * ── 2026-10-15（M0 工单 3）：**整组移除** ──
 *
 * 工单的口径是逐项三选一（实现 / 移除 / 降级为非交互元素），
 * **不允许留下"disabled + 借口"**。这五项按第二条办：
 *
 *   · 官网 / 帮助与反馈 / 添加账号 / 退出登录：本机版**没有任何目的地**
 *     （无站点、无反馈通道、无账号服务端、无登录态）——
 *     一个永远点不动的菜单项，用户看不见比看见了强；
 *   · 检查更新：更新链路是《后续篇》Phase 15 的事，**现在做不出真的检查**。
 *     它回来的时候该带着真更新器，而不是先占一个灰位。
 *
 * 「额度用量」那一行**保留**：它不是按钮，是把已用量如实显示出来的地方。
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

      {/* 额度用量：本机版按已用量算不出"时段额度"，所以只显示用量本身 */}
      <div className="wb-acct-quota" data-testid="wb-acct-quota">
        <span className="wb-acct-radio" />
        <span>当前时段额度用量</span>
        <em>—</em>
      </div>
    </div>
  );
}
