import { useEffect, useMemo, useRef, useState } from "react";

import { formatChord, isMacPlatform } from "@shared/keymap";
import { useWorkbenchStore } from "./store";
import { useAppSettings } from "./appSettings";

/**
 * **命令面板**（G13，2026-10-18）。
 *
 * ## 它解决什么
 *
 * 左栏有 8 个入口、设置里还有 9 页 —— 找一个动作要"记得它在哪一栏"。
 * 命令面板把**可执行的动作**收进一个输入框：`Ctrl/Cmd + K` → 输几个字 → 回车。
 *
 * ## 只放**真的能用**的动作（不留死项）
 *
 * 列表里每一条都必须有真实的落点：切视图、开合画布/左栏、打开设置。
 * 找不到的动作不列 —— 那正是 `deadControls` 那条纪律在命令面板里的版本。
 *
 * ## 键盘
 *
 * `Ctrl/Cmd+K` 开合、`Esc` 关、`↑/↓` 选、`Enter` 执行。全程不用鼠标。
 */

type Action = {
  id: string;
  label: string;
  hint: string;
  /** 关键词（拼音/英文都行；中文标签本身也参与匹配） */
  keys: string;
  run: () => void;
};

export function CommandPalette({ open, onClose }: { open: boolean; onClose: () => void }) {
  const setView = useWorkbenchStore((s) => s.setView);
  const toggleCanvas = useWorkbenchStore((s) => s.toggleCanvas);
  const toggleNav = useWorkbenchStore((s) => s.toggleNav);
  const rules = useAppSettings((s) => s.rules);
  /* L06：开合键位可自定义 —— 占位文案跟着键位表走 */
  const paletteChord = useAppSettings((s) => s.keymap.palette);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const paletteKeyHint = useMemo(() => {
    if (!paletteChord) return "无快捷键";
    const mac = (() => {
      try {
        return isMacPlatform(typeof navigator === "undefined" ? "" : navigator.platform);
      } catch {
        return false;
      }
    })();
    return formatChord(paletteChord, mac);
  }, [paletteChord]);

  const actions = useMemo<Action[]>(
    () => [
      { id: "home", label: "新建任务", hint: "回到首页", keys: "new task home 新建 任务 首页", run: () => setView("home") },
      { id: "scheduled", label: "定时任务", hint: "查看与新建定时任务", keys: "schedule cron 定时 任务", run: () => setView("scheduled") },
      { id: "usage", label: "用量与追踪", hint: "成本 / 请求追踪", keys: "usage cost trace 用量 成本 追踪", run: () => setView("usage") },
      { id: "permissions", label: "权限矩阵", hint: "角色 × 档位怎么判", keys: "permission policy 权限 矩阵 审批", run: () => setView("permissions") },
      { id: "workflow", label: "工作流", hint: "多 agent 泳道", keys: "workflow 工作流 泳道", run: () => setView("workflow") },
      { id: "plugins", label: "插件 · 技能 · 伙伴", hint: "连接器与技能", keys: "plugin skill mcp 插件 技能 连接器", run: () => setView("plugins") },
      { id: "phone", label: "手机遥控电脑", hint: "本地配对", keys: "phone remote 手机 遥控", run: () => setView("phone") },
      { id: "canvas", label: "打开 / 关闭画布", hint: "产物面板", keys: "canvas 画布 白板", run: () => toggleCanvas() },
      { id: "nav", label: "收起 / 展开左栏", hint: "导航", keys: "sidebar nav 左栏 收起", run: () => toggleNav() },
      /*
       * 设置（G16）：键盘用户不该为了打开设置去 Tab 遍左栏。
       * 走的是左栏已经在听的那个事件（`dsh-open-settings`）——不新开一条"打开设置"的路。
       */
      {
        id: "settings",
        label: "设置",
        hint: "模型 / 权限 / 知识库 / 个性化",
        keys: "settings preferences 设置 偏好 通用",
        run: () => window.dispatchEvent(new CustomEvent("dsh-open-settings")),
      },
      /*
       * 诊断包（G17）：预览后导出。命令面板里也要有 —— 否则"反馈"只长在输入区
       * 那一颗按钮上，键盘用户又回到"要记得它在哪"。
       */
      {
        id: "diagnostics",
        label: "反馈 / 导出诊断包",
        hint: "先预览再导出（只落本机，不上报）",
        keys: "feedback diagnostics 反馈 诊断 日志 bug",
        run: () => window.dispatchEvent(new CustomEvent("dsh-open-diagnostics")),
      },
    ],
    [setView, toggleCanvas, toggleNav],
  );

  /* 只按输入过滤；空输入列出全部（面板本身就是"看看有什么能做的"） */
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return actions;
    return actions.filter((a) => `${a.label} ${a.hint} ${a.keys}`.toLowerCase().includes(q));
  }, [actions, query]);

  useEffect(() => {
    if (open) {
      setQuery("");
      setActive(0);
      /* 打开就聚焦：用户按了 Ctrl+K 就是要打字 */
      setTimeout(() => inputRef.current?.focus(), 0);
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setActive((i) => (shown.length ? (i + 1) % shown.length : 0));
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setActive((i) => (shown.length ? (i - 1 + shown.length) % shown.length : 0));
        return;
      }
      if (e.key === "Enter") {
        e.preventDefault();
        const action = shown[active];
        if (action) {
          action.run();
          onClose();
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, shown, active, onClose]);

  if (!open) return null;

  return (
    <div className="wb-palette-mask" data-testid="wb-palette" onClick={onClose}>
      <div className="wb-palette" onClick={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          className="wb-palette-input"
          data-testid="wb-palette-input"
          placeholder={`输入动作名（${paletteKeyHint} 开合）`}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setActive(0);
          }}
        />
        <div className="wb-palette-list" data-testid="wb-palette-list">
          {shown.length === 0 ? (
            <div className="wb-palette-empty">没有匹配的动作{query ? `：「${query}」` : ""}</div>
          ) : (
            shown.map((action, index) => (
              <button
                key={action.id}
                type="button"
                className={`wb-palette-item${index === active ? " is-active" : ""}`}
                data-testid={`wb-palette-item-${action.id}`}
                onClick={() => {
                  action.run();
                  onClose();
                }}
                onMouseEnter={() => setActive(index)}
              >
                <span className="wb-palette-label">{action.label}</span>
                <span className="wb-palette-hint">{action.hint}</span>
              </button>
            ))
          )}
        </div>
        {rules.length ? (
          <div className="wb-palette-foot">权限规则：{rules.length} 条（设置 → 本机档案 里看）</div>
        ) : null}
      </div>
    </div>
  );
}
