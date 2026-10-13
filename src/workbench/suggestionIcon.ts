import {
  BarChart3,
  Briefcase,
  Cloud,
  FileText,
  Frame,
  Globe,
  MousePointerClick,
  Network,
  Presentation,
  Sparkles,
  Table,
} from "lucide-react";
import type { ComponentType } from "react";

/**
 * 推荐卡左侧那枚**类目图标**。
 *
 * 依据本体首页实机截图（`dynamic-ui/shot-doubaowork-chat-chat.png`）：
 * 每张卡左侧有一枚**浅蓝圆角方块 + 白色字形**的小图标，而且**每个类目的字形不同**
 * （云文档是云、PDF 是文档、VOC与舆情调研是图表、PPT 是演示）。
 *
 * 之前我给所有推荐卡都用同一枚 ✨ —— 那是最容易看出来的"统一化"痕迹。
 *
 * ⚠️ 字形是**按类目名对着截图的语义选的**（截图分辨率下看不清具体线性图标），
 * 所以这里保真的是**形态**（方块 + 每个类目各自一枚），不是像素级同一枚图标。
 * 素材来源按用户口径用图标库（lucide），不追本体素材。
 */
const BY_TAG: Record<string, ComponentType<{ size?: number | string; className?: string }>> = {
  云文档: Cloud,
  PDF: FileText,
  "VOC与舆情调研": BarChart3,
  PPT: Presentation,
  Word: FileText,
  可视化: BarChart3,
  表格: Table,
  Excel: Table,
  网页: Globe,
  画布: Frame,
  思维导图: Network,
  操作浏览器: MousePointerClick,
  一级市场公司评估: Briefcase,
};

export function suggestionIcon(tag: string): ComponentType<{ size?: number | string; className?: string }> {
  return BY_TAG[tag] ?? Sparkles;
}
