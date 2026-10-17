import { useEffect, useRef, useState } from "react";

import {
  KEY_ACTIONS,
  KEY_ACTION_LABELS,
  chordFromEvent,
  formatChord,
  isMacPlatform,
  type KeyAction,
} from "@shared/keymap";
import { PERSONA_EXTRA_MAX, PERSONA_STYLES } from "@shared/persona";
import { useAppSettings } from "./appSettings";
import { THEME_OPTIONS, applyTheme, readTheme, saveTheme, type Theme } from "./theme";

/**
 * **个性化面板**（L06）：主题 / 快捷键 / 助手人格。
 *
 * ## 为什么单独一个组件
 *
 * `SettingsPages.tsx` 已经接近结构上限，而这三块各有一点点自己的状态
 * （录制中的键位、还没提交的输入框）。放在一起会让那个文件既长又难读；
 * 这里只负责表单，判定与收窄全在 `@shared/keymap`、`@shared/persona` 里。
 *
 * ## 三条"不牺牲可读性"的取舍
 *
 * 1. **主题不提供任意配色**：只有系统/浅色/深色三档 —— 都是设计令牌里
 *    算过对比度的那些。自由配色一定会有用户选出看不清的组合；
 * 2. **键位录制必须带 Ctrl/Cmd**（`validateChord` 拦裸键）：裸键会在打字时吃输入；
 * 3. **人格只影响提示词**：称呼/语气/补充说明都进系统提示词，**不碰**字号、
 *    行宽与配色 —— 界面可读性不随个人偏好漂。
 */

/** 当前平台是不是 macOS（显示 `Cmd` 与 `Ctrl` 的区别）。 */
function platformIsMac(): boolean {
  try {
    return isMacPlatform(typeof navigator === "undefined" ? "" : navigator.platform);
  } catch {
    return false;
  }
}

export function PersonalizePanel() {
  const keymap = useAppSettings((s) => s.keymap);
  const persona = useAppSettings((s) => s.persona);
  const setKeyChord = useAppSettings((s) => s.setKeyChord);
  const setPersona = useAppSettings((s) => s.setPersona);

  const [theme, setTheme] = useState<Theme>(() => readTheme());
  /** 正在录制的动作（null = 没在录）。 */
  const [recording, setRecording] = useState<KeyAction | null>(null);
  const [keyError, setKeyError] = useState("");
  const recordingRef = useRef<KeyAction | null>(null);
  recordingRef.current = recording;

  /* 主题：选好即生效并落盘（与账号菜单里那一套是同一个函数，不会两套行为） */
  const onTheme = (next: Theme): void => {
    saveTheme(next);
    applyTheme(next);
    setTheme(next);
  };

  /*
   * 录制：按下的那一下在**捕获阶段**拦掉（不让它触发别的快捷键），
   * 只认第一次带主键的组合。Esc 取消。
   */
  useEffect(() => {
    if (!recording) return;
    const onKey = (e: KeyboardEvent): void => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape") {
        setRecording(null);
        setKeyError("");
        return;
      }
      const action = recordingRef.current;
      if (!action) return;
      const chord = chordFromEvent(e);
      if (!chord) return; /* 只按了修饰键：继续等主键 */
      setRecording(null);
      void setKeyChord(action, chord).then((got) => {
        setKeyError(got.ok ? "" : got.reason);
      });
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [recording, setKeyChord]);

  const mac = platformIsMac();

  return (
    <div className="wb-setpage-body" data-testid="wb-personalize">
      {/* ── 主题 ── */}
      <div className="wb-setpage-row">
        <span className="wb-setpage-label">主题</span>
        <select
          className="wb-setpage-select"
          data-testid="wb-personalize-theme"
          value={theme}
          onChange={(e) => onTheme(e.target.value as Theme)}
          aria-label="主题"
        >
          {THEME_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
      </div>

      {/* ── 快捷键 ── */}
      {KEY_ACTIONS.map((action) => (
        <div className="wb-setpage-row" key={action}>
          <span className="wb-setpage-label">{KEY_ACTION_LABELS[action]}</span>
          <button
            className="wb-setpage-btn"
            data-testid={`wb-personalize-key-${action}`}
            aria-label={`修改「${KEY_ACTION_LABELS[action]}」的快捷键`}
            onClick={() => {
              setKeyError("");
              setRecording(recording === action ? null : action);
            }}
          >
            {recording === action
              ? "按下新快捷键…（Esc 取消）"
              : keymap[action]
                ? formatChord(keymap[action], mac)
                : "未设置"}
          </button>
        </div>
      ))}
      <div className="wb-setpage-note" data-testid="wb-personalize-key-note">
        快捷键至少要带 {mac ? "Cmd" : "Ctrl"}（裸键会在打字时把输入吃掉）；修改后立即生效。
      </div>
      {keyError ? (
        <div className="wb-setpage-note" role="alert" data-testid="wb-personalize-key-error">
          {keyError}
        </div>
      ) : null}

      {/* ── 助手人格（只影响提示词，不改界面排版） ── */}
      <div className="wb-setpage-row">
        <span className="wb-setpage-label">称呼</span>
        <input
          className="wb-setpage-select"
          data-testid="wb-personalize-call"
          defaultValue={persona.callUser ?? ""}
          placeholder="比如：主人（留空则不特别指定）"
          maxLength={20}
          aria-label="助手怎么称呼你"
          onBlur={(e) => void setPersona({ callUser: e.target.value })}
        />
      </div>
      <div className="wb-setpage-row">
        <span className="wb-setpage-label">语气</span>
        <select
          className="wb-setpage-select"
          data-testid="wb-personalize-style"
          value={persona.style ?? "default"}
          onChange={(e) => void setPersona({ style: e.target.value as "default" | "concise" | "warm" })}
          aria-label="回答语气"
        >
          {PERSONA_STYLES.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}（{opt.hint}）
            </option>
          ))}
        </select>
      </div>
      <div className="wb-setpage-row">
        <span className="wb-setpage-label">补充</span>
        <textarea
          className="wb-setpage-select"
          data-testid="wb-personalize-extra"
          defaultValue={persona.extra ?? ""}
          placeholder="想让它记住的表达偏好（最多 500 字）；只影响说话方式，不改任务目标"
          maxLength={PERSONA_EXTRA_MAX}
          rows={2}
          aria-label="补充的表达偏好"
          onBlur={(e) => void setPersona({ extra: e.target.value })}
        />
      </div>
      <div className="wb-setpage-note">
        人格只写进系统提示词（每轮跟随），不影响字号、行宽与配色 —— 界面可读性不随偏好变。
      </div>
    </div>
  );
}
