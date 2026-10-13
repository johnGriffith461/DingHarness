import { useEffect, useRef, useState } from "react";
import {
  AudioLines,
  Clapperboard,
  Folder,
  HelpCircle,
  ListTodo,
  PenLine,
  Search,
  Settings,
  Sparkles,
  Wand2,
} from "lucide-react";

/**
 * 输入区「技能」按钮展开的**命令面板**。
 *
 * 形态依据本体实机截图（`app-triage/dynamic-ui/shot-skills-panel-2.png`）：
 * 它不是"已装能力清单"，而是一个**命令面板 + 推荐**，锚在输入框左边缘、近全宽，
 * 底部还有搜索框。三块内容：
 *
 *   1. 命令区   —— 选择项目 / 用量 / 工作模式设置 / 技能管理 / 创建画布 / 反馈
 *   2. 推荐区   —— 「推荐 (N)」标题 + 若干带说明的条目
 *   3. 搜索区   —— 底部输入框
 *
 * 原来的实现在这里列的是「已装条目 + 勾选」，那是**另一个东西**（§132）。
 * 已装能力的选择仍在「插件」那个 chip 里保留 —— 那是本机版自己的入口。
 */

/** 命令区的一项。 */
type Command = { icon: typeof Folder; label: string; hint?: string };

/** 推荐区的一项。`name` 会加粗，`hint` 是后面的说明。 */
type Suggestion = { icon: typeof Folder; name: string; hint: string };

/** 命令区 —— 照抄本体截图里的 6 条。 */
const COMMANDS: Command[] = [
  { icon: Folder, label: "选择项目" },
  { icon: Sparkles, label: "用量" },
  { icon: Settings, label: "工作模式设置" },
  { icon: ListTodo, label: "技能管理" },
  { icon: PenLine, label: "创建画布", hint: "在无限画布中自由创建图片与视频" },
  { icon: HelpCircle, label: "反馈", hint: "发送有关此聊天的反馈" },
];

/** 推荐区 —— 照抄本体截图里的 5 条（名字与说明都来自截图）。 */
const SUGGESTIONS: Suggestion[] = [
  { icon: Sparkles, name: "可视化", hint: "将数据、流程、机制、架构、关系和时间线转成 ECharts 或确定性 HTML/SVG 可视化" },
  { icon: ListTodo, name: "定时任务", hint: "创建、查看、更新或删除定时任务" },
  { icon: Wand2, name: "创建技能", hint: "帮你创建一个新技能" },
  { icon: AudioLines, name: "Seed Audio 1.0", hint: "面向有声书、播客、影视配音等音频创作场景，原生直出2分钟的人声&音乐&音效复合音频" },
  { icon: Clapperboard, name: "Seedance 2.5", hint: "面向专业版用户，新一代旗舰视频模型，原生直出 30 秒视频" },
];

export type SkillPanelProps = {
  /** 关闭面板。 */
  onClose: () => void;
  /** 点某条命令 / 推荐时的回调（本机版多数没有后端，由调用方决定怎么如实呈现）。 */
  onPick?: (label: string) => void;
};

export default function SkillPanel({ onClose, onPick }: SkillPanelProps) {
  const [query, setQuery] = useState("");
  const rootRef = useRef<HTMLDivElement | null>(null);

  // 点外面 / Esc 关掉 —— 面板该有的基本行为
  useEffect(() => {
    const onDown = (e: MouseEvent): void => {
      // 点的是 chip 本身时不关（否则会"关了又被 chip 的 onClick 打开"）
      const t = e.target as HTMLElement;
      if (t.closest('[data-testid="wb-skills"]')) return;
      if (rootRef.current && !rootRef.current.contains(t)) onClose();
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
   * 按关键词过滤。
   *
   * @param text 条目的可搜文本
   * @returns 命中则 true
   */
  const hit = (text: string): boolean => (query ? text.toLowerCase().includes(query.toLowerCase()) : true);

  const commands = COMMANDS.filter((c) => hit(c.label + (c.hint ?? "")));
  const suggestions = SUGGESTIONS.filter((s) => hit(s.name + s.hint));

  return (
    <div className="wb-cmd-panel" ref={rootRef} data-testid="wb-skill-panel">
      <div className="wb-cmd-scroll">
        {commands.length > 0 ? (
          <div className="wb-cmd-group">
            {commands.map((c, i) => (
              <button
                key={c.label}
                className={`wb-cmd-item${i === 0 ? " is-first" : ""}`}
                data-testid={`wb-cmd-${c.label}`}
                onClick={() => {
                  onPick?.(c.label);
                  onClose();
                }}
              >
                <c.icon size={15} />
                <b>{c.label}</b>
                {c.hint ? <em>{c.hint}</em> : null}
              </button>
            ))}
          </div>
        ) : null}

        {suggestions.length > 0 ? (
          <>
            <div className="wb-cmd-head">推荐 ({suggestions.length})</div>
            <div className="wb-cmd-group">
              {suggestions.map((s) => (
                <button
                  key={s.name}
                  className="wb-cmd-item is-rec"
                  data-testid={`wb-rec-${s.name}`}
                  onClick={() => {
                    onPick?.(s.name);
                    onClose();
                  }}
                >
                  <s.icon size={15} />
                  <b>{s.name}</b>
                  <em>{s.hint}</em>
                </button>
              ))}
            </div>
          </>
        ) : null}

        {commands.length === 0 && suggestions.length === 0 ? (
          <div className="wb-cmd-empty">没有匹配「{query}」的命令或推荐</div>
        ) : null}
      </div>

      <div className="wb-cmd-search">
        <Search size={14} />
        <input
          data-testid="wb-cmd-search"
          value={query}
          placeholder="搜索..."
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>
    </div>
  );
}
