import { List, PanelLeftClose } from "lucide-react";
import { useWorkbenchStore } from "./store";

/**
 * 「打开 / 收起左侧栏」（2026-10-15，M0 工单 3）。
 *
 * ## 为什么收成一个组件
 *
 * 这颗按钮原来在**六个地方各写了一遍**（云盘 / 插件·技能·伙伴 / 定时任务 /
 * 手机遥控电脑 / 任务视图 / 任务中心），而且六处都是 `disabled` + 同一句
 * 「本机版还没做折叠」—— 工单点名的 26 处死控件里，它一个占五处。
 * 收成一个组件之后，一处实现六处受益；以后改文案或图标也不会又漂成六份。
 *
 * ## 为什么收起后不需要浮标
 *
 * 它在**页面头部**（主区里），不在左栏里 —— 左栏收成 0 宽之后它照样在，
 * 点一下就能展开。所以这里只要一个"两态"按钮，标题跟着状态走。
 * （右栏摘要面板不一样：它把自己连头部一起收掉，所以要在右缘挂浮标当展开入口。）
 */
export function NavCollapseButton() {
  const collapsed = useWorkbenchStore((s) => s.navCollapsed);
  const toggleNav = useWorkbenchStore((s) => s.toggleNav);
  const label = collapsed ? "展开左侧栏" : "收起左侧栏";

  return (
    <button className="wb-icon" data-testid="wb-nav-collapse" aria-label={label} title={label} onClick={toggleNav}>
      {collapsed ? <List size={15} /> : <PanelLeftClose size={15} />}
    </button>
  );
}
