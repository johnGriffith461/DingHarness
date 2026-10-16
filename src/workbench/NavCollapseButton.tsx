import { List, PanelLeftClose } from "lucide-react";
import { useWorkbenchStore } from "./store";

/**
 * 「打开 / 收起左侧栏」（2026-10-15，M0 工单 3）。
 *
 * ## 为什么收成一个组件
 *
 * 这颗按钮原来在**五个页面各写了一遍**（手机遥控电脑 / 插件·技能·伙伴 / 定时任务 /
 * 历史对话 / 任务视图），而且都是 `disabled` + 同一句「本机版还没做折叠」——
 * 工单点名的 26 处死控件里，它一个占好几处。
 * 收成一个组件之后，一处实现几处受益；以后改文案或图标也不会又漂成几份。
 *
 * ## 为什么收起后不需要浮标
 *
 * 它在**页面头部**（主区里），不在左栏里 —— 左栏收成 0 宽之后它照样在，
 * 点一下就能展开。所以这里只要一个"两态"按钮，标题跟着状态走。
 * （右栏摘要面板不一样：它把自己连头部一起收掉，所以要在右缘挂浮标当展开入口。）
 *
 * ## ⚠️ 必须**带字**（2026-10-16 审计 P192）
 *
 * 原来这里只有一枚 15px 的图标（靠 `title` 提示语义），而同一批工单刚把右栏那颗
 * 「关的入口只有一枚没字的箭头」判成缺陷并改成带字的「收起」（见 `SummaryPanel` 的
 * `wb-summary-collapse`）—— 同一个仓里两套口径，用户学一次不够。
 * 更硬的理由：左栏收起之后**它是唯一的回程**（见上一条），
 * 这种情况下"要点得着、且一眼看出是干什么的"就不是美观问题了。
 * 样式与右栏那颗同一条规则（`ding-harness-shell.css`），所以两处形态不会再漂。
 */
export function NavCollapseButton() {
  const collapsed = useWorkbenchStore((s) => s.navCollapsed);
  const toggleNav = useWorkbenchStore((s) => s.toggleNav);
  const label = collapsed ? "展开左侧栏" : "收起左侧栏";

  return (
    <button
      className="wb-nav-collapse"
      data-testid="wb-nav-collapse"
      aria-label={label}
      title={label}
      onClick={toggleNav}
    >
      {collapsed ? <List size={13} /> : <PanelLeftClose size={13} />} {collapsed ? "展开" : "收起"}
    </button>
  );
}
