/**
 * 插件 / 技能目录（阶段 11.7）。
 *
 * 条目名与说明都是从实机截图里对下来的（HANDOFF §25.2）。**关键是给每条一个稳定的 id** ——
 * 没有 id 就谈不上"装过哪些"：上位在请求里传的是
 * `extraExt.input_skill = JSON.stringify({skill_id, skill_type})`，
 * 也就是按 **id** 声明要启用什么，不是按名字。
 *
 * 「安装」这件事在上位是服务端状态（`installed/uninstallable/installVersion` 都由服务端返回）。
 * 我们是单机版，所以装在本地；但**契约照抄**：装过的是 id 集合。
 */

/** 目录里的一个条目。 */
export type CatalogItem = {
  /** 稳定 id（装过哪些看的就是它）。 */
  id: string;
  /** 属于插件还是技能（对上位的两个 tab）。 */
  type: "plugin" | "skill";
  name: string;
  hint: string;
  /** 「N 万人在用」那行。 */
  users: string;
  /** 分类（插件页的分类 chip）。 */
  category: string;
};

/** 必备精选（两张大卡）。 */
export const FEATURED_ITEMS: CatalogItem[] = [
  {
    id: "browser-operator",
    type: "plugin",
    name: "操作浏览器",
    hint: "通过操作浏览器完成网页导航、读取、填表、下载等任务。",
    users: "",
    category: "精选",
  },
  {
    id: "computer-operator",
    type: "plugin",
    name: "操作电脑",
    hint: "让 AI 直接操控你的 Windows，完成文件管理、应用操作等本地电脑任务。",
    users: "",
    category: "精选",
  },
];

/** 「特别推荐」的 15 个插件。 */
export const RECOMMENDED_PLUGINS: CatalogItem[] = [
  ["feishu", "飞书", "直接完成飞书文档、日历…", "16.4 万人在用"],
  ["wecom", "企业微信", "通过企业微信 CLI …", "50.4 万人在用"],
  ["dingtalk", "钉钉", "通过钉钉 CLI 使用…", "41 万人在用"],
  ["tencent-meeting", "腾讯会议", "预约和管理会议，…", "14.7 万人在用"],
  ["notion", "Notion", "连接 Notion 进行…", "2.7 万人在用"],
  ["baidu-netdisk", "百度网盘", "搜索、上传、下载…", "8.3 万人在用"],
  ["wind-alice", "Wind Alice", "查询股票、基金，…", "3.6 万人在用"],
  ["ths-ifind", "同花顺 iFinD", "查询股票、基金，…", "8.1 万人在用"],
  ["tdx", "通达信", "金融 AI 的数据底座，…", "5 万人在用"],
  ["eastmoney-miaoxiang", "东方财富妙想", "查询东方财富提供…", "3.2 万人在用"],
  ["tushare", "Tushare", "获取股票、基金…", "8981 人在用"],
  ["jinmen", "进门投研", "覆盖券商研究所，…", "2588 人在用"],
  ["yingmi", "盈米基金", "基金筛选、诊断、…", "4305 人在用"],
  ["financial-data", "Financial Data", "查询财报财报、价…", "3360 人在用"],
  ["qcc", "企查查", "企业信息搜索、工…", "6.2 万人在用"],
].map(([id, name, hint, users]) => ({ id, type: "plugin" as const, name, hint, users, category: "特别推荐" }));

/** 技能页的条目（按分组）。 */
export const SKILL_GROUPS: Array<{ group: string; items: CatalogItem[] }> = [
  {
    group: "金融",
    items: [
      ["stock-research", "个股研究", "深度分析上市公司…", "32.2 万人在用"],
      ["valuation", "估值建模", "三表预测、DCF、…", "15.1 万人在用"],
      ["market-hotspot", "市场热点分析", "市场整体与宏观事…", "19.6 万人在用"],
      ["earnings", "业绩分析", "上市公司财报/季…", "16.1 万人在用"],
      ["announcement", "公告解读", "解读上市公司公告…", "12.4 万人在用"],
      ["primary-market", "一级市场公司评…", "评估一级市场项目…", "9.9 万人在用"],
    ].map(([id, name, hint, users]) => ({ id, type: "skill" as const, name, hint, users, category: "金融" })),
  },
  {
    group: "多媒体创作",
    items: [
      ["short-drama", "短剧创作", "帮你生成短剧、动…", "45.6 万人在用"],
      ["ui-design", "UI 设计", "设计并交付可评审…", "10.6 万人在用"],
      ["visual", "视觉创作", "品牌产品等设计企…", "11.9 万人在用"],
    ].map(([id, name, hint, users]) => ({ id, type: "skill" as const, name, hint, users, category: "多媒体创作" })),
  },
];

/** 全部条目（插件 + 技能）。 */
export const CATALOG: CatalogItem[] = [
  ...FEATURED_ITEMS,
  ...RECOMMENDED_PLUGINS,
  ...SKILL_GROUPS.flatMap((g) => g.items),
];

/** 按 id 取条目。 */
export function findItem(id: string): CatalogItem | undefined {
  return CATALOG.find((item) => item.id === id);
}

/** 目录里的全部 id（入库时用来剔除已经不在目录里的旧 id）。 */
export const CATALOG_IDS = new Set(CATALOG.map((item) => item.id));
