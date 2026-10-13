import { describe, expect, it } from "vitest";
import {
  GENERATION_LIMIT,
  IMAGE_PAGE_LABELS,
  VIDEO_PAGE_LABELS,
  addGeneration,
  canRetry,
  downloadName,
  type Generation,
} from "@shared/imagePage";

/**
 * 生成图片独立页的纯逻辑（§165）。
 *
 * 断言对着 `docs/evidence-aicreation.txt`（`aiCreation_*` 330 条）。
 * **生成与尺寸选择不在这里**（它们早就在 `src/canvas/GeneratePanel.tsx` 里，有各自的测试）——
 * 这一层只做"这一页独有的东西"。
 */
const gen = (patch: Partial<Generation> = {}): Generation => ({
  url: "http://127.0.0.1:9/img/a.png",
  name: "a.png",
  prompt: "一只橘猫",
  model: "m1",
  size: "1024x1024",
  at: 1_700_000_000_000,
  ...patch,
});

describe("文案与本体对齐（逐字取自 aiCreation_* 证据）", () => {
  it("标题与占位", () => {
    expect(IMAGE_PAGE_LABELS.title).toBe("图片生成");
    expect(IMAGE_PAGE_LABELS.placeholder).toBe("描述你想生成的图片");
  });

  it("三个动作与两条失败话术", () => {
    expect(IMAGE_PAGE_LABELS.retry).toBe("重新生成");
    expect(IMAGE_PAGE_LABELS.save).toBe("保存图片");
    expect(IMAGE_PAGE_LABELS.download).toBe("下载");
    expect(IMAGE_PAGE_LABELS.saveFailed).toBe("保存失败，请重试");
    expect(IMAGE_PAGE_LABELS.downloadFailed).toBe("下载失败，请重试");
  });

  it("素材分类是「图片」（自定的两条另标）", () => {
    expect(IMAGE_PAGE_LABELS.category).toBe("图片");
    expect(IMAGE_PAGE_LABELS.recent).toBe("最近生成");
  });
});

describe("addGeneration", () => {
  it("新的在最前", () => {
    const got = addGeneration([gen({ url: "u1" })], gen({ url: "u2" }));
    expect(got.map((g) => g.url)).toEqual(["u2", "u1"]);
  });

  it("⭐ 同一个 url 不重复收（否则像生成了两次）", () => {
    const got = addGeneration([gen({ url: "u1", prompt: "旧" })], gen({ url: "u1", prompt: "新" }));
    expect(got).toHaveLength(1);
    expect(got[0]?.prompt).toBe("新");
  });

  it("超过上限砍最旧的", () => {
    let list: Generation[] = [];
    for (let i = 0; i < GENERATION_LIMIT + 3; i += 1) list = addGeneration(list, gen({ url: `u${i}` }));
    expect(list).toHaveLength(GENERATION_LIMIT);
    expect(list[0]?.url).toBe(`u${GENERATION_LIMIT + 2}`);
  });

  it("不改原数组", () => {
    const src = [gen({ url: "u1" })];
    addGeneration(src, gen({ url: "u2" }));
    expect(src).toHaveLength(1);
  });
});

describe("downloadName", () => {
  it("url 里有文件名就用它", () => {
    expect(downloadName(gen({ url: "http://x/y/照片-1.png" }))).toBe("照片-1.png");
  });

  it("url 里没有像样的文件名 → 用落盘名", () => {
    expect(downloadName(gen({ url: "http://x/y", name: "b.webp" }))).toBe("b.webp");
  });

  it("⭐ 都没有 → 用提示词前几个字 + 时间戳", () => {
    const got = downloadName(gen({ url: "http://x/", name: "noext", prompt: "一只橘猫坐在窗台" }));
    expect(got.startsWith("一只橘猫坐在窗台-")).toBe(true);
    expect(got.endsWith(".png")).toBe(true);
  });

  it("⭐ 提示词里的路径分隔符等**必须清掉**（否则下载会变成奇怪的路径）", () => {
    const got = downloadName(gen({ url: "http://x/", name: "noext", prompt: "../../etc/passwd:名字" }));
    expect(got).not.toContain("/");
    expect(got).not.toContain("\\");
    expect(got).not.toContain(":");
    expect(got).not.toContain("..");
  });

  it("提示词为空也给得出名字（不返回空串）", () => {
    const got = downloadName(gen({ url: "http://x/", name: "noext", prompt: "   " }));
    expect(got.startsWith("图片-")).toBe(true);
  });

  it("扩展名可以换（例如 webp）", () => {
    expect(downloadName(gen({ url: "http://x/", name: "noext", prompt: "猫" }), "webp").endsWith(".webp")).toBe(true);
  });
});

describe("canRetry", () => {
  it("有提示词就能重来", () => {
    expect(canRetry(gen())).toBe(true);
  });

  it("没提示词（或没有记录）就不给按钮", () => {
    expect(canRetry(gen({ prompt: "  " }))).toBe(false);
    expect(canRetry(null)).toBe(false);
  });
});


describe("视频页文案（§174，逐字取自 aiCreation_* 证据）", () => {
  it("标题与分类", () => {
    expect(VIDEO_PAGE_LABELS.title).toBe("视频生成");
    expect(VIDEO_PAGE_LABELS.category).toBe("视频");
  });

  it("提示词占位是证据里那句", () => {
    expect(VIDEO_PAGE_LABELS.placeholder).toBe("描述你想要的视频");
  });

  it("⭐ 空态用的是证据原话 —— 那句里「图片和视频」两个都在（生成记录本来就共用一份）", () => {
    expect(VIDEO_PAGE_LABELS.recentEmpty).toBe("生成的图片和视频会显示在这里");
  });

  it("段标题与图片页同一个词（证据里没有单独给视频的那一个）", () => {
    expect(VIDEO_PAGE_LABELS.recent).toBe(IMAGE_PAGE_LABELS.recent);
  });
});
