import { describe, expect, it } from "vitest";
import { FILE_LIST_LIMIT, formatFileList } from "@shared/fileList";
import type { DriveEntry } from "@shared/drive";
import { ORIGIN_LABEL } from "@shared/drive";

/**
 * 「列文件」工具要说的那段话（2026-10-14）。
 *
 * 与「读文件」是一对：只读会让 agent"只能处理用户报得出名字的文件"。
 * 这里钉三件容易做错的事：**空目录要说空**、**超出上限要说明总量**、
 * **每条要写清"在哪个目录、多大"**（模型据此才知道该读哪个）。
 */
const entry = (name: string, over: Partial<DriveEntry> = {}): DriveEntry => ({
  name,
  path: `D:/data/drive/${name}`,
  bytes: 2048,
  createdAt: 0,
  modifiedAt: 0,
  kind: "other",
  origin: "drive",
  ...over,
});

describe("formatFileList", () => {
  it("空目录**说清是空的**（回空串会让模型以为工具坏了，然后去猜）", () => {
    const got = formatFileList([]);
    expect(got).toContain("还没有文件");
  });

  it("每条写上名字 + 大小 + 在哪个目录", () => {
    const got = formatFileList([entry("季度总结.md"), entry("封面.png", { origin: "asset", bytes: 3 * 1024 * 1024 })]);
    expect(got).toContain("季度总结.md");
    expect(got).toContain("2KB");
    expect(got).toContain("在云盘目录");
    expect(got).toContain("封面.png");
    expect(got).toContain("3.0MB");
    /*
     * ⚠️ 来源名**按界面那张表**断言，不写死中文（审计 P104）：这里原来是
     * `toContain("在生成图目录")` —— 它把"同一批文件在界面上叫素材、在留痕里叫生成图"
     * 这个两份名钉成了"预期行为"。现在取 `ORIGIN_LABEL.asset`，两边只能同源。
     */
    expect(got).toContain(`在${ORIGIN_LABEL.asset}目录`);
  });

  it("开头报总数（模型据此判断要不要继续问）", () => {
    expect(formatFileList([entry("a.md"), entry("b.md")])).toContain("共 2 个文件");
  });

  it(`⭐ 超过 ${FILE_LIST_LIMIT} 个只列前 ${FILE_LIST_LIMIT} 个，并**说明总量**`, () => {
    const many = Array.from({ length: FILE_LIST_LIMIT + 25 }, (_, i) => entry(`f${i}.md`));
    const got = formatFileList(many);
    expect(got).toContain(`共 ${FILE_LIST_LIMIT + 25} 个文件`);
    expect(got).toContain(`只列了前 ${FILE_LIST_LIMIT} 个`);
    expect(got.split("\n").filter((l) => l.startsWith("- ")).length).toBe(FILE_LIST_LIMIT);
  });

  it("1KB 以下的文件不会显示成 0KB（那看着像空文件）", () => {
    expect(formatFileList([entry("tiny.md", { bytes: 20 })])).toContain("1KB");
  });
});
