import {
  BarChart3,
  Bell,
  Blocks,
  Briefcase,
  Calculator,
  Clapperboard,
  ClipboardList,
  Cloud,
  Database,
  FileSearch,
  FileText,
  Flame,
  HardDrive,
  Landmark,
  LineChart,
  Megaphone,
  MessageSquare,
  Monitor,
  MousePointerClick,
  Palette,
  PieChart,
  Search,
  Send,
  Sparkles,
  Square,
  Table,
  TrendingUp,
  Video,
} from "lucide-react";
import type { ComponentType } from "react";

import type { CatalogItem } from "./catalog";

/**
 * 目录条目（插件 / 技能）左侧那枚图标 —— 2026-10-14 界面体检的第一条发现。
 *
 * ## 为什么需要它
 * 体检时插件页上一眼看出来的问题：**15 张卡左侧是一模一样的空色块**
 * （`.wb-plugin-icon` 只有渐变底、里面什么都没画）。后果有两条：
 *   ① 扫不动 —— 卡片之间没有可辨识的记号，只能逐行读名字；
 *   ② 读起来像"图标没加载出来"（那个色块和卡片底色同调，最像断图）。
 *
 * `suggestionIcon.ts` 里记过同一类教训的原话：「之前我给所有推荐卡都用同一枚 ✨ ——
 * 那是最容易看出来的**统一化**痕迹」。这里照它的办法办：**一个 id 一枚图标**。
 *
 * ## 为什么按 id 而不是按名字
 * `catalog.ts` 的文件头写着：id 是稳定的、名字不是（名字是从截图对下来的文案）。
 * 所以映射挂在 **id** 上；名字改了图标不会跟着掉。
 *
 * ## 兜底
 * 没登记的 id 落到 `Square`（一枚中性的方块），**不是**回落到某枚具体图标 ——
 * 回落成"别的条目的图标"会让两条长得一样，正是要避免的那件事。
 */
const BY_ID: Record<string, ComponentType<{ size?: number | string; className?: string }>> = {
  // 必备精选
  "browser-operator": MousePointerClick,
  "computer-operator": Monitor,
  // 特别推荐（协作 / 会议 / 云盘）
  feishu: MessageSquare,
  wecom: Briefcase,
  dingtalk: Bell,
  "tencent-meeting": Video,
  notion: FileText,
  "baidu-netdisk": HardDrive,
  // 金融数据源
  "wind-alice": TrendingUp,
  "ths-ifind": LineChart,
  tdx: BarChart3,
  "eastmoney-miaoxiang": PieChart,
  tushare: Database,
  jinmen: Landmark,
  yingmi: Calculator,
  "financial-data": Table,
  qcc: FileSearch,
  // 技能：金融
  "stock-research": Search,
  valuation: Calculator,
  "market-hotspot": Flame,
  earnings: ClipboardList,
  announcement: Megaphone,
  "primary-market": Briefcase,
  // 技能：多媒体创作
  "short-drama": Clapperboard,
  "ui-design": Palette,
  visual: Sparkles,
  // 其它（云盘里的条目等）
  cloud: Cloud,
  artifact: Send,
  plugin: Blocks,
};

/** 取一条目录条目的图标。 */
export function catalogIcon(item: Pick<CatalogItem, "id">): ComponentType<{ size?: number | string; className?: string }> {
  return BY_ID[item.id] ?? Square;
}
