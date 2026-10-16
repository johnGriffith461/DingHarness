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
 * 形态依据本体实机截图（`app-triage/dynamic-ui/shot-skills-panel-2.png`）：  ⚠️（该依据未入库、本机也找不到 —— 无法复核；判据以本文件里的断言为准）
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
type Command = {
  icon: typeof Folder;
  label: string;
  hint?: string;
  /** 是不是"画布开关"那一条（它的 testid 固定，不随文案变）。 */
  isCanvas?: boolean;
  /**
   * 本机版没有对应后端时**如实写在这里**（渲染成禁用 + 悬停说明）。
   * 不写的话它就成了一颗"点了没反应"的死按钮 —— §124 审计报的就是这类。
   */
  todo?: string;
};

/** 推荐区的一项。`name` 会加粗，`hint` 是后面的说明。 */
type Suggestion = { icon: typeof Folder; name: string; hint: string };

/**
 * 命令区 —— 照抄本体截图里的 6 条。
 *
 * ⚠️ 是**函数**不是常量：画布那一条要按"现在开着没有"换文案
 * （模块级常量读不到 props，第一版写成常量直接编译不过）。
 *
 * @param canvasOpen 画布当前是否打开
 */
function commandsFor(canvasOpen: boolean): Command[] {
  return [
    /*
     * 这六条是照本体命令区抄的，但**能不能点要逐条说清**（2026-10-14）：
     *   选择项目 / 工作模式设置 / 技能管理 / 创建画布 → 本机版都接得上（走 onPick）
     * 原来六条全是死按钮（`onPick` 根本没接），用户点了没反应只会以为坏了。
     *
     * ⚠️ 2026-10-17（V5 开工前清尾 §2.4）：
     *   · 「反馈」**真做**了 —— 本机版的反馈通道 = 导出诊断包（`feedbackExport.ts`，
     *     复用 doctor 那套自检；不上报任何东西），所以它不再 disabled；
     *   · 「用量」保留禁用态，但文案改成**诚实版**（"团队版可用"）——
     *     它真的归宿是 V5-3 的成本账本（账本按成员/团队汇总），本机版这一格没后端。
     */
    { icon: Folder, label: "选择项目" },
    { icon: Sparkles, label: "用量", todo: "团队版可用" },
    { icon: Settings, label: "工作模式设置" },
    { icon: ListTodo, label: "技能管理" },
    /*
     * 关着 = 「创建画布」（与本体命令区逐字一致）；
     * 开着 = 「收起画布」（同一位置反向动作）——画布工具条里没有关闭键，
     * 所以**这一条就是唯一的退路**，不能只有"创建"。
     */
    {
      icon: PenLine,
      isCanvas: true,
      label: canvasOpen ? "收起画布" : "创建画布",
      hint: canvasOpen ? "回到对话与任务" : "在无限画布中自由创建图片与视频",
    },
    { icon: HelpCircle, label: "反馈", hint: "导出诊断包（本机版的反馈通道；不会自动上报）" },
  ];
}

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
  /**
   * 点某条命令 / 推荐时的回调。
   *
   * @returns 返回 **`false`** 表示"这一条我自己处理了面板的开合，你别再关"。
   *   ⚠️ 为什么需要这个：面板的 onClick 原来是 `onPick(...)` **紧接着** `onClose()` ——
   *   而「选择项目 / 工作模式设置」这两条要做的恰恰是**把面板换成另一个下拉**
   *   （开合共用 `openPop` 一个状态），紧跟其后的 `onClose()` 会把刚打开的又关掉。
   *   第一版就是这么写的，`accept-chips` 当场红（"点「选择项目」没打开项目 chip 的下拉"）。
   */
  onPick?: (label: string) => boolean | void;
  /**
   * 画布现在开着没有（2026-10-14）。
   *
   * 画布唯一的入口/出口就是这里的「创建画布」那一条 —— 右下角那颗浮动键已经撤了
   * （主人：本体是放在技能里的）。
   * 开着的时候这一条读作「收起画布」：**必须有退路**，否则用户进了画布就出不来
   * （画布自己的工具条里没有关闭键）。
   */
  canvasOpen?: boolean;
};

export default function SkillPanel({ onClose, onPick, canvasOpen = false }: SkillPanelProps) {
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

  const commands = commandsFor(canvasOpen).filter((c) => hit(c.label + (c.hint ?? "")));
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
                /*
                 * 画布那一条的 testid **不随文案变**：关着是「创建画布」、开着是「收起画布」，
                 * 但脚本与用户找的都是"画布那个开关"，所以给它一个稳定名字。
                 */
                data-testid={c.isCanvas ? "wb-canvas-toggle" : `wb-cmd-${c.label}`}
                aria-label={c.todo ? `${c.label}（${c.todo}）` : c.label}
                title={c.todo ?? ""}
                disabled={Boolean(c.todo)}
                onClick={() => {
                  if (onPick?.(c.label) !== false) onClose();
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
