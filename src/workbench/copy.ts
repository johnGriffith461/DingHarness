/**
 * 从原版 i18n 表里**原样取出来**的文案（阶段 11.4）。
 *
 * ## 为什么要专门一个文件
 * 复刻时最容易走偏的一步是"自己编一份看起来差不多的文案"。
 * 上位产物把几千条中文全放在一个扁平 key→文案 的表里，所以**没必要编**：
 * 键名本身就是契约，值直接抄。
 *
 * 本地还原方式（只读，不改原目录）：
 * ```
 * # 简中在 static/js/31606.js，繁体在 static/js/async/71169.js
 * # 中文是 \uXXXX 转义，解出来是 "key":"文案" 的扁平表
 * node <解析器> out.txt - <app>/static/js/31606.js <app>/static/js/async/71169.js
 * ```
 * 下面每条都标了原始 key，改的时候按 key 去对得上。
 */

/** 定时任务「为你推荐」的 9 张卡：**文案在本地，清单来自服务端**。 */
export const SCHEDULED_RECOMMEND: Array<{ id: number; titleKey: string; title: string; summary: string }> = [
  { id: 1, titleKey: "scheduledTasks_recommend_title_1", title: "工作周报", summary: "自动汇总本周工作进展，一键生成周报" },
  { id: 2, titleKey: "scheduledTasks_recommend_title_2", title: "每日安排简报", summary: "推送今日日程和待办，开启高效一天" },
  { id: 3, titleKey: "scheduledTasks_recommend_title_3", title: "每日新闻推送", summary: "汇总行业重要动态，按优先级排序推送" },
  { id: 4, titleKey: "scheduledTasks_recommend_title_4", title: "竞品动态调研", summary: "实时跟进竞品动态，清晰整理变动" },
  { id: 5, titleKey: "scheduledTasks_recommend_title_5", title: "股价监控", summary: "定期监控、分析股票走势和涨跌原因" },
  { id: 6, titleKey: "scheduledTasks_recommend_title_6", title: "每日英语单词", summary: "每日推送实用单词，带例句和记忆技巧" },
  { id: 7, titleKey: "scheduledTasks_recommend_title_7", title: "学点小知识", summary: "每天一个趣味小问答，拓展知识面" },
  { id: 8, titleKey: "scheduledTasks_recommend_title_8", title: "周末好去处", summary: "为你提供实用周末出行建议" },
  { id: 9, titleKey: "scheduledTasks_recommend_title_9", title: "商品价格监控", summary: "持续追踪心仪商品到手价，达到目标价格时即时提醒" },
];

/**
 * 上位 `recommend/list` **实际返回给这个账号的 7 条**（实机截图核对过顺序）。
 *
 * 本地表有 9 条是**超集** —— 服务端只发了 7 条。所以别把"9"当成"该显示 9 张"：
 * 清单由服务端起决定，本地只负责 id → 文案。
 */
export const SCHEDULED_SERVED_IDS = [3, 4, 5, 6, 7, 8, 9] as const;

/** 插件页的三个 tab（实机截图）。 */
export const PLUGIN_TABS = ["插件", "技能", "工作伙伴"] as const;

/**
 * **管理页**的三个分类。
 *
 * 与市场页的 `PLUGIN_TABS` 不同：第三个是「连接器」而不是「工作伙伴」——
 * 依据是本体管理页的实机截图（`dynamic-ui/shot-route-skills-plugin.png`，
 * 面包屑「市场 › 管理」，三个分类显示为 `插件 0` `技能 693` `连接器 0`）。
 *
 * `pages.tsx` 里那条注释早就写对了，只是代码一直用着市场页那个常量。
 */
export const ADMIN_TABS = ["插件", "技能", "连接器"] as const;

/** 插件页的分类 chip（实机截图逐条对下）。 */
export const PLUGIN_CATEGORIES = [
  "精选",
  "办公",
  "金融",
  "财税支付",
  "多媒体创作",
  "内容创作",
  "营销销售",
  "电商",
  "企业管理",
  "效率工具",
  "数据分析",
] as const;

/**
 * 首页「为你推荐」的候选卡。
 *
 * 实机那几条**是变的** —— 三次遍历分别看到
 * 「可视化 帮我把几组数据画在一起比较 / Word 帮我检查 Word 文档有没有问题 / …」、
 * 「可视化 帮我画清楚这些对象之间的关系 / PPT 制作一份 TED 风格演讲 / …」、
 * 「Word 写一份产品介绍 / 网页 做一个活动报名页 / …」。
 * 所以本地要有一个**比展示条数大的池子**，每次进首页抽几条 —— 写死四条会露馅。
 *
 * 每条都是「工具 + 要点」的形态（与实机一致）：前半句是能力，后半句是这次要干什么。
 */
export const SUGGESTION_POOL = [
  /*
   * 前四条是**从本体首页的实时文本转储里抄下来的原句**
   * （`app-triage/dynamic-ui/live-text.txt`，顺序就是实机顺序）：  ⚠️（该依据未入库、本机也找不到 —— 无法复核；判据以本文件里的断言为准）
   *
   *     为你推荐
   *     云文档    把这份长文档压缩一下
   *     PDF       帮我把 PDF 文档转成 Word
   *     VOC与舆情调研 帮我监控一下品牌的社媒口碑
   *     PPT       帮我把一堆资料做成 PPT
   *
   * 连**类目名**一起抄（云文档 / PDF / VOC与舆情调研 这三个类目我原来没有）。
   */
  "云文档 把这份长文档压缩一下",
  "PDF 帮我把 PDF 文档转成 Word",
  "VOC与舆情调研 帮我监控一下品牌的社媒口碑",
  "PPT 帮我把一堆资料做成 PPT",
  "PPT 制作一份 TED 风格演讲",
  "PPT 做一份个人年度成长报告",
  "操作浏览器 帮我把多页列表整理到一起",
  "可视化 帮我画清楚这些对象之间的关系",
  "可视化 帮我把几组数据画在一起比较",
  "Word 写一份总结汇报",
  "Word 帮我检查 Word 文档有没有问题",
  "Word 写一份产品介绍",
  "网页 做一个活动报名页",
  "表格 把这份名单整理成结构化表格",
  "Excel 做一份带公式的预算表",
  "一级市场公司评估 帮我看懂一份商业计划书",
  "画布 把这些素材排成一张海报",
  "思维导图 把这份纪要拆成大纲",
] as const;

/**
 * 把一条推荐卡拆成「类目」与「指令」两段。
 *
 * 形态依据本体首页实机截图（`dynamic-ui/shot-doubaowork-chat-chat.png`）：
 * 每个卡是**一行**、左侧一枚类目图标，然后是
 *
 *     云文档  把这份长文档压缩一下
 *
 * 也就是"类目 + 空格 + 指令"。所以用**第一个空格**切。
 * 池子里每条都必须有这个空格 —— 单测锁住，免得以后加条目时漏写类目。
 */
export function splitSuggestion(s: string): { tag: string; text: string } {
  const at = s.indexOf(" ");
  if (at <= 0) return { tag: s, text: "" };
  return { tag: s.slice(0, at), text: s.slice(at + 1) };
}

/** 首页展示的推荐卡条数（实机是四条）。 */
export const SUGGESTION_COUNT = 4;

/**
 * 从池子里抽 `count` 条推荐卡。
 *
 * @param pool 候选池
 * @param count 抽几条
 * @param random 取随机数的函数（测试里传入固定值）
 * @returns 抽中的若干条；池子比 count 小时就全给
 */
export function pickSuggestions(
  pool: readonly string[],
  count: number = SUGGESTION_COUNT,
  random: () => number = Math.random,
): string[] {
  const remaining = [...pool];
  const picked: string[] = [];
  while (picked.length < count && remaining.length > 0) {
    const index = Math.min(remaining.length - 1, Math.floor(random() * remaining.length));
    picked.push(...remaining.splice(index, 1));
  }
  return picked;
}

/** 右侧面板的四个 tab（`sidePanel_summary_tab_*`）。 */
export const SUMMARY_TABS = [
  { id: "artifacts", label: "产物", key: "sidePanel_summary_tab_artifacts" },
  { id: "browser", label: "浏览器", key: "sidePanel_summary_tab_browser" },
  { id: "media", label: "图片与视频", key: "sidePanel_summary_tab_media" },
  { id: "subtasks", label: "子智能体", key: "sidePanel_summary_tab_subtasks" },
] as const;

export type SummaryTabId = (typeof SUMMARY_TABS)[number]["id"];

/** 面板说明：只扫最近 N 条消息的产物（`sidePanel_summary_desc_recentMessageLimit`）。 */
export const SUMMARY_RECENT_LIMIT_NOTE = "仅支持查看最近 50 条消息的产物";

/** 会话产物 / 最近文件（`summary_sessionfiles` / `summary_recentfiles`）。 */
export const SUMMARY_SESSION_FILES = "对话产物";
export const SUMMARY_RECENT_FILES = "最近文件";

/** 问候与输入区（实机截图文案）。 */
export const HOME_GREETING = "今天有什么工作要处理?";
export const COMPOSER_PLACEHOLDER = "发消息或创建任务... / 使用技能 @ 添加资料";
export const SCHEDULE_COMPOSER_PLACEHOLDER = "给 Ding Harness 安排任务";

/** 生成中的产物标题（`building_my_artifacts_title_generate_cn`）。 */
export const ARTIFACT_TITLE_GENERATING = "标题生成中...";

/**
 * 标题长度口径（`moa_comms_taskTitleLimit`）。
 *
 * 这条证实了**任务标题是模型起的**，不是本地截断 —— 它是工具参数的 description，
 * 也就是"让模型知道该产出什么"的说明。见 `task.ts` 的 `TITLE_PROMPT`。
 */
export const TASK_TITLE_LIMIT = 16;
