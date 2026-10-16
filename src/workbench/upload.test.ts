import { describe, expect, it } from "vitest";
import {
  UPLOAD_HINTS,
  UPLOAD_PANEL_LABELS,
  uploadedNote,
  UPLOAD_REASON_LABEL,
  UPLOAD_STATUSES,
  UPLOAD_STATUS_LABEL,
  UNSUPPORTED_EXT,
  isUnsupported,
  shouldShowPanel,
  summarize,
  taskLine,
  toTasks,
  type UploadTask,
} from "@shared/upload";

/**
 * 上传任务的状态与文案（§170）。
 *
 * 断言对着 `docs/evidence-drive.txt` 里的 `drive_upload_*`（十余条，逐字）。  ⚠️（该依据未入库、本机也找不到 —— 无法复核；判据以本文件里的断言为准）
 */
const task = (patch: Partial<UploadTask> = {}): UploadTask => ({
  name: "a.md",
  ok: true,
  status: "uploaded",
  ...patch,
});

describe("文案与本体对齐（逐字取自 drive_upload_*）", () => {
  it("状态那几句", () => {
    expect(UPLOAD_STATUS_LABEL.notStarted).toBe("未开始");
    expect(UPLOAD_STATUS_LABEL.uploading).toBe("正在上传");
    expect(UPLOAD_STATUS_LABEL.parsing).toBe("正在解析");
    expect(UPLOAD_STATUS_LABEL.uploaded).toBe("已完成");
    expect(UPLOAD_STATUS_LABEL.failed).toBe("解析失败");
  });

  it("失败原因那几句", () => {
    expect(UPLOAD_REASON_LABEL.formatUnsupported).toBe("暂不支持该文件类型");
    expect(UPLOAD_REASON_LABEL.parseFail).toBe("解析失败");
    expect(UPLOAD_REASON_LABEL.inappropriateContent).toBe("该文件不合规");
  });

  it("面板三个按钮", () => {
    expect(UPLOAD_PANEL_LABELS.close).toBe("关闭");
    expect(UPLOAD_PANEL_LABELS.collapse).toBe("收起");
    expect(UPLOAD_PANEL_LABELS.expand).toBe("展开");
  });

  it("六个状态都有说法（一个都不许漏，否则界面会显示 undefined）", () => {
    for (const s of UPLOAD_STATUSES) {
      expect(typeof UPLOAD_STATUS_LABEL[s], `状态 ${s}`).toBe("string");
      expect(UPLOAD_STATUS_LABEL[s].length).toBeGreaterThan(0);
    }
  });
});

describe("isUnsupported（**拒绝清单**，不是白名单）", () => {
  it("可执行与安装包那一类不接", () => {
    for (const ext of ["exe", "msi", "bat", "ps1", "dll"]) {
      expect(isUnsupported(`某个东西.${ext}`), ext).toBe(true);
    }
  });

  it("大小写不敏感", () => {
    expect(isUnsupported("病毒.EXE")).toBe(true);
  });

  it("⭐ 少见但正当的格式**照收**（白名单会把它们误挡在门外，代价太大）", () => {
    for (const name of ["设计稿.psd", "资料.zip", "电子书.epub", "没有扩展名", "无扩展名."]) {
      expect(isUnsupported(name), name).toBe(false);
    }
  });

  it("清单里确实是可执行那几种（不与文档格式混在一起）", () => {
    expect(UNSUPPORTED_EXT).not.toContain("md");
    expect(UNSUPPORTED_EXT).not.toContain("docx");
    expect(UNSUPPORTED_EXT).not.toContain("png");
  });

  it("⭐ P08：脚本宿主与安装包那一族**一个都不许漏**（漏掉一个 = 云盘成了分发程序的地方）", () => {
    /*
     * 原来这份清单只有 13 个，缺 `hta/wsf/cpl/pif/jar/msix/appx` ——
     * 而 `hta` 是 mshta.exe 的入口、`jar` 有 JRE 就能跑，与 `.exe` 同级。
     * 这条把"必须挡住的那些"逐字钉死：删任何一个都变红。
     */
    for (const ext of ["hta", "wsf", "cpl", "pif", "jar", "msix", "appx"]) {
      expect(isUnsupported(`某个东西.${ext}`), `${ext} 没在拒绝清单里`).toBe(true);
    }
  });
});

describe("toTasks", () => {
  it("成功=已完成、失败=解析失败", () => {
    const got = toTasks([{ name: "a.md", ok: true }, { name: "b.exe", ok: false, reason: "formatUnsupported" }]);
    expect(got[0]?.status).toBe("uploaded");
    expect(got[1]?.status).toBe("failed");
  });

  it("失败原因原样带过来", () => {
    expect(toTasks([{ name: "b.exe", ok: false, reason: "formatUnsupported" }])[0]?.reason).toBe("formatUnsupported");
  });

  it("空列表给空数组", () => {
    expect(toTasks([])).toEqual([]);
  });
});

describe("summarize（`drive_upload_status_sum`）", () => {
  it("成功与失败各数各的", () => {
    expect(summarize([task(), task({ name: "b.mp4", ok: false, status: "failed" })])).toBe("已上传 1 个，1 个上传失败");
  });

  it("全成功时也照说（不省那个 0 —— 证据里就是两个数都给）", () => {
    expect(summarize([task(), task({ name: "b.md" })])).toBe("已上传 2 个，0 个上传失败");
  });

  it("空列表给 0 / 0", () => {
    expect(summarize([])).toBe("已上传 0 个，0 个上传失败");
  });
});

describe("taskLine", () => {
  it("成功只说状态", () => {
    expect(taskLine(task())).toBe("已完成");
  });

  it("⭐ 失败要把原因带上（只说「解析失败」用户不知道该换什么）", () => {
    expect(taskLine(task({ ok: false, status: "failed", reason: "formatUnsupported" }))).toBe(
      "解析失败（暂不支持该文件类型）",
    );
  });

  it("失败但没有原因时只说状态（不硬编一个原因）", () => {
    expect(taskLine(task({ ok: false, status: "failed" }))).toBe("解析失败");
  });
});

describe("shouldShowPanel", () => {
  it("没有任务就不显示（别占着云盘页的地方）", () => {
    expect(shouldShowPanel([])).toBe(false);
  });

  it("有任务就显示", () => {
    expect(shouldShowPanel([task()])).toBe(true);
  });
});


describe("拖拽上传（§171）", () => {
  it("⭐ 拖拽区不编新词 —— 用证据里已有的两句（`drop`/`拖拽` 在证据里一条都搜不到）", () => {
    expect(UPLOAD_HINTS.file).toBe("上传文件");
    expect(UPLOAD_HINTS.image).toBe("上传图片");
  });

  it("成功提示按证据那句（`drive_toast_uploaded_number`）", () => {
    expect(uploadedNote(3)).toBe("已上传 3 个文件");
    expect(uploadedNote(0)).toBe("已上传 0 个文件");
  });
});
