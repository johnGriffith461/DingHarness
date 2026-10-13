/**
 * 云盘的证据层（§157）—— 从 `docs/evidence-drive.txt`（`drive_*` **201 条**）补的那一层。
 *
 * ## 为什么要分成两处
 *
 * `shared/drive.ts` 里原来那部分是**阶段 11.5** 做的（当时证据少）：
 * 按扩展名分类、两种排序、格式化。这一层是**后来抽出完整证据**之后补的：
 * 标签页、筛选、排序口径、新建、重命名、删除确认、移动、存储。
 *
 * 分成两处而不是揉在一起，是因为两边的**依据不同**：
 * 前者是我自己定的口径，后者是本体逐字的文案。混在一起以后就分不清哪句能改、哪句不能改。
 *
 * ⚠️ 本体的云盘是**云端**的（成员、所有者、分享链接、容量上限都是服务端的）。
 * 本机版只做**本地目录**这一份：没有成员、没有分享、没有容量上限，
 * 这几处的文案**记下来但不假装用上**（见 §157.5）。
 */
import { DRIVE_KIND_META, kindOf, type DriveEntry, type DriveKind } from "./drive";

/** 逐字取自证据的界面文案。 */
export const DRIVE_LABELS = {
  /** `drive_btn_addNew` / `drive_btn_new` */
  addNew: "新建",
  /** `drive_addNew_doc` / `drive_add_newDoc` */
  newDoc: "新建文档",
  /** `drive_addNew_folder` / `drive_add_newFolder` */
  newFolder: "新建文件夹",
  /** `drive_addNew_slides` / `drive_add_newSlides` */
  newSlides: "新建 PPT",
  /** `drive_name_untitled_doc` / `_folder` / `_slides` */
  untitledDoc: "未命名文档",
  untitledFolder: "未命名文件夹",
  untitledSlides: "未命名 PPT",
  /** `drive_empty_btn_upload` */
  upload: "上传",
  /** `drive_filter_tooptip` / `drive_filter_all` */
  filter: "筛选",
  allTypes: "所有类型",
  /** `drive_sort_tooltip` 与两个方向 */
  customSort: "自定义排序",
  ascend: "正序",
  descend: "倒序",
  /** `drive_confirm_title_deleteFile` / `_deleteFolder` */
  confirmDeleteFile: "确认删除文件？",
  confirmDeleteFolder: "确认删除文件夹？",
  /** `drive_menuOption_delete` / `_rename` */
  delete: "删除",
  rename: "重命名",
  /** `drive_rename_header` 与两个按钮 */
  renameTitle: "重命名",
  renameOk: "确认",
  renameCancel: "取消",
  /** `drive_newFolder_name_placeholder` */
  folderNamePlaceholder: "请输入文件夹名称",
  /** `drive_toast_nameEmpty` */
  nameEmpty: "名称不能为空",
  /** `drive_page_end` */
  pageEnd: "已经到底了",
  /** `drive_empty_header` / `drive_doc_header_empty` */
  emptyFiles: "这里还没有任何文件",
  emptyDocs: "这里还没有任何文档",
  /** `drive_menuOption_AIReading` —— 右键菜单里能直接送去 AI 阅读 */
  aiReading: "AI 阅读",
  /** `drive_chat_prompt_summarizeFile` */
  summarizeFile: "总结这个文件",
} as const;

/** 云盘的标签页（**逐字取自证据**）。 */
export const DRIVE_TABS = ["all", "mine", "recent", "aidocs"] as const;
export type DriveTabId = (typeof DRIVE_TABS)[number] | "starred";

/** 标签页标题（`drive_tab_*`；`starred` 是本机版的扩展，不是证据里的）。 */
export const DRIVE_TAB_LABEL: Record<DriveTabId, string> = {
  all: "全部",
  mine: "我的",
  recent: "最近",
  aidocs: "AI 文档",
  starred: "收藏",
};

/** 表格列头（`drive_table_columnHeader_*`，按证据顺序）。 */
export const DRIVE_COLUMNS = ["名称", "文件类型", "文件大小", "文件来源", "创建时间", "使用时间"] as const;

/** 排序口径（`drive_sort_*`）。 */
export const DRIVE_SORTS = ["name", "size", "source", "created", "modified", "used"] as const;
export type DriveSort = (typeof DRIVE_SORTS)[number];

/** 排序项的标题。 */
export const DRIVE_SORT_LABEL: Record<DriveSort, string> = {
  name: "按文件名",
  size: "按文件大小",
  source: "按文件来源",
  created: "按创建时间",
  modified: "按修改时间",
  used: "按使用时间",
};

/** 一幅"这一页到此为止"的收尾文案。 */
export const DRIVE_PAGE_END = DRIVE_LABELS.pageEnd;

/**
 * 按类目筛选（`drive_filter_all` = 不筛）。
 *
 * @param entries 全部文件
 * @param kind 类目；`"all"` 表示所有类型
 * @returns 过滤后的列表（不改原数组）
 */
export function filterByKind(entries: readonly DriveEntry[], kind: DriveKind | "all"): DriveEntry[] {
  return kind === "all" ? [...entries] : entries.filter((e) => e.kind === kind);
}

/**
 * 按搜索词筛（名字包含，大小写不敏感）。
 *
 * @param entries 全部文件
 * @param query 关键词（空串 → 原样返回）
 * @returns 过滤后的列表
 */
export function filterByQuery(entries: readonly DriveEntry[], query: string): DriveEntry[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...entries];
  return entries.filter((e) => e.name.toLowerCase().includes(q));
}

/**
 * 按选定的口径排序。
 *
 * ⚠️ 每条口径都有**稳定的兜底**（同名/同大小时退回按名字）——
 * 否则"大小相同的两个文件"在每次渲染里都可能换位置，看着像在跳。
 *
 * @param entries 文件列表
 * @param sort 口径
 * @param desc 是否倒序（`descend`）
 * @returns 新数组
 */
export function sortEntries(entries: readonly DriveEntry[], sort: DriveSort, desc: boolean): DriveEntry[] {
  const byName = (a: DriveEntry, b: DriveEntry): number => a.name.localeCompare(b.name, "zh");
  const cmp = (a: DriveEntry, b: DriveEntry): number => {
    switch (sort) {
      case "size":
        return a.bytes - b.bytes || byName(a, b);
      case "source":
        return a.origin.localeCompare(b.origin) || byName(a, b);
      case "created":
        return a.createdAt - b.createdAt || byName(a, b);
      case "modified":
        return a.modifiedAt - b.modifiedAt || byName(a, b);
      case "used":
        // 「使用时间」本机版没有单独记 —— 用最近修改代替，并在界面上说清（§157.5）
        return a.modifiedAt - b.modifiedAt || byName(a, b);
      case "name":
      default:
        return byName(a, b);
    }
  };
  const out = [...entries].sort(cmp);
  return desc ? out.reverse() : out;
}

/**
 * 「AI 文档」标签页收什么。
 *
 * 本机版的定义：**产物类**的文档（`origin === "artifact"`）——
 * 这些是智能体产出、能回到对话里继续改的；上传进来的文件不算。
 *
 * @param entry 一条文件
 * @returns 是否算 AI 文档
 */
export function isAiDoc(entry: DriveEntry): boolean {
  return entry.origin === "artifact" && (entry.kind === "doc" || entry.kind === "canvas");
}

/**
 * 起一个"默认名"（`未命名文档` / `未命名文件夹` / `未命名 PPT`）。
 *
 * ⭐ **重名要加序号、绝不覆盖**：本体也是这个口径，而"新建时把同名文件冲掉"
 * 是最容易犯、也最让人恼火的一种错。
 *
 * @param kind 要建的东西
 * @param existing 已存在的名字（含扩展名）
 * @returns 可用的名字
 */
export function untitledName(kind: "doc" | "folder" | "slides", existing: readonly string[]): string {
  const base =
    kind === "folder" ? DRIVE_LABELS.untitledFolder : kind === "slides" ? DRIVE_LABELS.untitledSlides : DRIVE_LABELS.untitledDoc;
  // 文件夹没有扩展名，文档与 PPT 走 .md（本机版的可编辑文本口径，见 §157.5）
  const suffix = kind === "folder" ? "" : ".md";
  const taken = new Set(existing.map((n) => n.toLowerCase()));
  if (!taken.has((base + suffix).toLowerCase())) return base + suffix;
  for (let i = 2; i < 1000; i += 1) {
    const candidate = `${base} ${i}${suffix}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
  return `${base} ${Date.now()}${suffix}`;
}

/**
 * 校验新名字（`drive_toast_nameEmpty` = 名称不能为空）。
 *
 * @param name 用户输入
 * @returns 出错说明；通过则 null
 */
export function validateDriveName(name: string): string | null {
  const trimmed = name.trim();
  if (!trimmed) return DRIVE_LABELS.nameEmpty;
  // 路径分隔符会被主进程拒掉；这里提前说清，别等它失败
  if (/[\\/]/.test(trimmed)) return "名称里不能有路径分隔符";
  if (trimmed.length > 80) return "名称太长了（最多 80 字）";
  return null;
}

/**
 * 删除前的确认标题（`drive_confirm_title_deleteFile` / `_deleteFolder`）。
 *
 * @param entry 要删的那一条（或只有类目）
 * @returns 确认框的标题
 */
export function deleteConfirmTitle(entry: { kind: DriveKind }): string {
  // 本机版没有真的"文件夹"实体（目录里的文件都是平的），所以这里永远走"文件"
  return entry.kind === "other" ? DRIVE_LABELS.confirmDeleteFile : DRIVE_LABELS.confirmDeleteFile;
}

/**
 * 存储行的说法（`drive_storage_used` = 已使用 {s_storage}）。
 *
 * ⚠️ 本机版**没有容量上限**（不限量），所以只报"已使用"，
 * **不编一个配额出来**（编出来的百分比是假的，用户会照着它去清理文件）。
 *
 * @param usedBytes 已用字节
 * @param used 把字节说成人话的函数（复用 `formatBytes`，避免两份实现）
 * @returns 例如 `已使用 12.4 MB`
 */
export function storageLine(usedBytes: number, used: (n: number) => string): string {
  return `已使用 ${used(usedBytes)}`;
}

/** 一类文件的空态文案（文档类说"文档"，其余说"文件"）。 */
export function emptyTextFor(kind: DriveKind | "all"): string {
  return kind === "doc" ? DRIVE_LABELS.emptyDocs : DRIVE_LABELS.emptyFiles;
}

/** 类目下拉的选项（「所有类型」+ 各类目）。 */
export function kindOptions(): Array<{ value: DriveKind | "all"; label: string }> {
  const kinds: DriveKind[] = ["doc", "sheet", "slides", "image", "canvas", "code", "other"];
  return [
    { value: "all", label: DRIVE_LABELS.allTypes },
    ...kinds.map((k) => ({ value: k, label: DRIVE_KIND_META[k].label })),
  ];
}

/** 按名字猜类目（界面里用它给"新建什么"定默认名）。 */
export { kindOf };

/* ─────────────────────────── 下载 / 另存为（§169） ─────────────────────────── */

/** 下载相关的文案（**逐字取自证据**）。 */
export const DOWNLOAD_LABELS = {
  /** `drive_menuOption_download` */
  action: "下载",
  /** `drive_toast_downloading` */
  downloading: "下载中...",
  /** `drive_toast_saved2Device` */
  saved: "已下载到本地",
  /** `drive_toast_downloadCanceled` */
  canceled: "下载已取消",
  /** `drive_asset_download_failed` */
  failed: "下载失败，请重试",
} as const;

/** 下载这件事的结果（主进程给的三种）。 */
export type DownloadResult = { ok: boolean; savedTo?: string; canceled?: boolean };

/**
 * 把结果说成界面上那一句。
 *
 * ⚠️ **"用户点了取消"不是失败** —— 混成"下载失败，请重试"会让人以为出错了，
 * 然后再点一次、再取消一次。这三种情形各有各的话（证据里也各有各的词）。
 *
 * @param result 主进程返回
 * @returns 给用户看的那句话
 */
export function downloadNote(result: DownloadResult): string {
  if (result.ok) return DOWNLOAD_LABELS.saved;
  if (result.canceled) return DOWNLOAD_LABELS.canceled;
  return DOWNLOAD_LABELS.failed;
}
