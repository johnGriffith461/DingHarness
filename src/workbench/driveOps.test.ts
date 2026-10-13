import { describe, expect, it } from "vitest";
import { formatBytes, type DriveEntry } from "@shared/drive";
import {
  DOWNLOAD_LABELS,
  downloadNote,
  DRIVE_COLUMNS,
  DRIVE_LABELS,
  DRIVE_PAGE_END,
  DRIVE_SORTS,
  DRIVE_SORT_LABEL,
  DRIVE_TABS,
  DRIVE_TAB_LABEL,
  deleteConfirmTitle,
  emptyTextFor,
  filterByKind,
  filterByQuery,
  isAiDoc,
  kindOptions,
  sortEntries,
  storageLine,
  untitledName,
  validateDriveName,
} from "@shared/driveOps";

/**
 * 云盘的证据层（§157）。
 *
 * 断言对着 `docs/evidence-drive.txt`（`drive_*` 201 条，本体前端包里的原文）。
 * 这里全是**本地可算准**的东西：筛选、排序、默认名、校验、空态、文案。
 */
const e = (patch: Partial<DriveEntry> = {}): DriveEntry => ({
  name: "a.md",
  path: "D:/x/a.md",
  bytes: 100,
  createdAt: 1000,
  modifiedAt: 1000,
  kind: "doc",
  origin: "drive",
  ...patch,
});

describe("文案与本体对齐（逐字取自 drive_* 证据）", () => {
  it("新建那三个与它们的默认名", () => {
    expect(DRIVE_LABELS.addNew).toBe("新建");
    expect(DRIVE_LABELS.newDoc).toBe("新建文档");
    expect(DRIVE_LABELS.newFolder).toBe("新建文件夹");
    expect(DRIVE_LABELS.newSlides).toBe("新建 PPT");
    expect(DRIVE_LABELS.untitledDoc).toBe("未命名文档");
    expect(DRIVE_LABELS.untitledFolder).toBe("未命名文件夹");
    expect(DRIVE_LABELS.untitledSlides).toBe("未命名 PPT");
  });

  it("筛选与排序", () => {
    expect(DRIVE_LABELS.filter).toBe("筛选");
    expect(DRIVE_LABELS.allTypes).toBe("所有类型");
    expect(DRIVE_LABELS.customSort).toBe("自定义排序");
    expect(DRIVE_LABELS.ascend).toBe("正序");
    expect(DRIVE_LABELS.descend).toBe("倒序");
  });

  it("排序口径的六个名字", () => {
    expect(DRIVE_SORTS).toEqual(["name", "size", "source", "created", "modified", "used"]);
    expect(DRIVE_SORT_LABEL.name).toBe("按文件名");
    expect(DRIVE_SORT_LABEL.size).toBe("按文件大小");
    expect(DRIVE_SORT_LABEL.modified).toBe("按修改时间");
    expect(DRIVE_SORT_LABEL.used).toBe("按使用时间");
  });

  it("删除确认的标题与重命名的那几个词", () => {
    expect(DRIVE_LABELS.confirmDeleteFile).toBe("确认删除文件？");
    expect(DRIVE_LABELS.renameTitle).toBe("重命名");
    expect(DRIVE_LABELS.renameOk).toBe("确认");
    expect(DRIVE_LABELS.renameCancel).toBe("取消");
    expect(DRIVE_LABELS.folderNamePlaceholder).toBe("请输入文件夹名称");
  });

  it("空态、到底、名称校验", () => {
    expect(DRIVE_LABELS.emptyFiles).toBe("这里还没有任何文件");
    expect(DRIVE_LABELS.emptyDocs).toBe("这里还没有任何文档");
    expect(DRIVE_PAGE_END).toBe("已经到底了");
    expect(DRIVE_LABELS.nameEmpty).toBe("名称不能为空");
  });

  it("四个标签页的名字（本体就是这四个）", () => {
    expect(DRIVE_TABS).toEqual(["all", "mine", "recent", "aidocs"]);
    expect(DRIVE_TAB_LABEL.all).toBe("全部");
    expect(DRIVE_TAB_LABEL.mine).toBe("我的");
    expect(DRIVE_TAB_LABEL.recent).toBe("最近");
    expect(DRIVE_TAB_LABEL.aidocs).toBe("AI 文档");
  });

  it("表格列头按证据顺序", () => {
    expect(DRIVE_COLUMNS).toEqual(["名称", "文件类型", "文件大小", "文件来源", "创建时间", "使用时间"]);
  });
});

describe("filterByKind", () => {
  const list = [e({ name: "a.md", kind: "doc" }), e({ name: "b.png", kind: "image" }), e({ name: "c.xlsx", kind: "sheet" })];

  it("「所有类型」原样返回（但要是新数组）", () => {
    const got = filterByKind(list, "all");
    expect(got).toHaveLength(3);
    expect(got).not.toBe(list);
  });

  it("按类目筛", () => {
    expect(filterByKind(list, "image").map((x) => x.name)).toEqual(["b.png"]);
  });

  it("没有该类目时给空数组（界面自己说空态）", () => {
    expect(filterByKind(list, "slides")).toEqual([]);
  });
});

describe("filterByQuery", () => {
  const list = [e({ name: "季度复盘.md" }), e({ name: "Report.PDF" })];

  it("空关键词原样返回", () => {
    expect(filterByQuery(list, "  ")).toHaveLength(2);
  });

  it("按名字包含，大小写不敏感", () => {
    expect(filterByQuery(list, "report").map((x) => x.name)).toEqual(["Report.PDF"]);
  });

  it("中文照常", () => {
    expect(filterByQuery(list, "复盘").map((x) => x.name)).toEqual(["季度复盘.md"]);
  });
});

describe("sortEntries", () => {
  const a = e({ name: "b.md", bytes: 200, createdAt: 2, modifiedAt: 5, origin: "drive" });
  const b = e({ name: "a.md", bytes: 100, createdAt: 3, modifiedAt: 1, origin: "artifact" });

  it("按文件名（中文按拼音序）", () => {
    expect(sortEntries([a, b], "name", false).map((x) => x.name)).toEqual(["a.md", "b.md"]);
  });

  it("倒序就是反过来", () => {
    expect(sortEntries([a, b], "name", true).map((x) => x.name)).toEqual(["b.md", "a.md"]);
  });

  it("按大小 / 创建 / 修改", () => {
    // a = b.md（200B, 建于 2, 改于 5）；b = a.md（100B, 建于 3, 改于 1）
    expect(sortEntries([a, b], "size", false).map((x) => x.name)).toEqual(["a.md", "b.md"]);
    expect(sortEntries([a, b], "created", false).map((x) => x.name)).toEqual(["b.md", "a.md"]);
    expect(sortEntries([a, b], "modified", false).map((x) => x.name)).toEqual(["a.md", "b.md"]);
  });

  it("⭐ 同值时按名字兜底 —— 否则「大小相同的两个文件」每次渲染都可能换位置", () => {
    const x = e({ name: "b.md", bytes: 5 });
    const y = e({ name: "a.md", bytes: 5 });
    expect(sortEntries([x, y], "size", false).map((n) => n.name)).toEqual(["a.md", "b.md"]);
  });

  it("不改原数组（store 里的顺序不能被搅乱）", () => {
    const list = [a, b];
    sortEntries(list, "name", true);
    expect(list.map((x) => x.name)).toEqual(["b.md", "a.md"]);
  });
});

describe("isAiDoc（「AI 文档」标签页收什么）", () => {
  it("产物类文档算", () => {
    expect(isAiDoc(e({ origin: "artifact", kind: "doc" }))).toBe(true);
    expect(isAiDoc(e({ origin: "artifact", kind: "canvas" }))).toBe(true);
  });

  it("⭐ 上传进来的不算 —— 它的「前任」不在这台机器的对话里", () => {
    expect(isAiDoc(e({ origin: "drive", kind: "doc" }))).toBe(false);
    expect(isAiDoc(e({ origin: "export", kind: "doc" }))).toBe(false);
  });

  it("产物的图片也不算（那个去图片类目里找）", () => {
    expect(isAiDoc(e({ origin: "artifact", kind: "image" }))).toBe(false);
  });
});

describe("untitledName", () => {
  it("没重名就用默认名，且带扩展名", () => {
    expect(untitledName("doc", [])).toBe("未命名文档.md");
    expect(untitledName("slides", [])).toBe("未命名 PPT.md");
  });

  it("文件夹没有扩展名", () => {
    expect(untitledName("folder", [])).toBe("未命名文件夹");
  });

  it("⭐ 重名加序号，**绝不覆盖**", () => {
    expect(untitledName("doc", ["未命名文档.md"])).toBe("未命名文档 2.md");
    expect(untitledName("doc", ["未命名文档.md", "未命名文档 2.md"])).toBe("未命名文档 3.md");
  });

  it("重名判断不区分大小写（Windows 上 .MD 与 .md 是同一个）", () => {
    expect(untitledName("doc", ["未命名文档.MD"])).toBe("未命名文档 2.md");
  });
});

describe("validateDriveName", () => {
  it("空的挡住，并给出证据里那句", () => {
    expect(validateDriveName("   ")).toBe("名称不能为空");
  });

  it("路径分隔符提前挡住（别等主进程失败）", () => {
    expect(validateDriveName("a/b")).toContain("路径分隔符");
    expect(validateDriveName("a\\b")).toContain("路径分隔符");
  });

  it("过长挡住", () => {
    expect(validateDriveName("长".repeat(81))).toContain("太长");
  });

  it("正常名字通过（首尾空白不算）", () => {
    expect(validateDriveName("  周报  ")).toBeNull();
  });
});

describe("空态 / 存储 / 选项", () => {
  it("文档类空态说「文档」，其余说「文件」", () => {
    expect(emptyTextFor("doc")).toBe("这里还没有任何文档");
    expect(emptyTextFor("image")).toBe("这里还没有任何文件");
  });

  it("⭐ 存储行只说「已使用」 —— 本机版没有配额，不编一个百分比出来", () => {
    const line = storageLine(1300000, formatBytes);
    expect(line).toBe("已使用 1.2 MB");
    expect(line).not.toContain("%");
  });

  it("类目下拉含「所有类型」与七个类目", () => {
    const opts = kindOptions();
    expect(opts[0]).toEqual({ value: "all", label: "所有类型" });
    expect(opts).toHaveLength(8);
  });

  it("删除确认标题取文件那一句（本机版没有真的文件夹实体）", () => {
    expect(deleteConfirmTitle({ kind: "doc" })).toBe("确认删除文件？");
  });
});


describe("下载 / 另存为（§169）", () => {
  it("文案逐字取自证据", () => {
    expect(DOWNLOAD_LABELS.action).toBe("下载");
    expect(DOWNLOAD_LABELS.saved).toBe("已下载到本地");
    expect(DOWNLOAD_LABELS.canceled).toBe("下载已取消");
    expect(DOWNLOAD_LABELS.failed).toBe("下载失败，请重试");
  });

  it("成功说「已下载到本地」", () => {
    expect(downloadNote({ ok: true, savedTo: "D:/某个地方/x.png" })).toBe("已下载到本地");
  });

  it("⭐ 用户点了取消 **不是失败** —— 混成「下载失败」会让人以为出错了，然后再点一次再取消一次", () => {
    expect(downloadNote({ ok: false, canceled: true })).toBe("下载已取消");
    expect(downloadNote({ ok: false, canceled: true })).not.toBe(DOWNLOAD_LABELS.failed);
  });

  it("真失败才说重试", () => {
    expect(downloadNote({ ok: false })).toBe("下载失败，请重试");
  });

  it("三种结果**三句不同的话**（不许有两句撞在一起）", () => {
    const said = [
      downloadNote({ ok: true }),
      downloadNote({ ok: false, canceled: true }),
      downloadNote({ ok: false }),
    ];
    expect(new Set(said).size).toBe(3);
  });
});
