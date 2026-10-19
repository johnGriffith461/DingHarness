import { beforeEach, describe, expect, it } from "vitest";

import { clearFileState, expectedFingerprint, noteRead, noteWrite } from "./fileState";

describe("fileState（读后写校验的会话级状态）", () => {
  beforeEach(() => clearFileState());

  it("按会话隔离：另一段对话读的不算这段读过", () => {
    noteRead("s1", "C:/a.ts", { mtimeMs: 1, size: 10 });
    expect(expectedFingerprint("s1", "C:/a.ts")).toEqual({ mtimeMs: 1, size: 10 });
    expect(expectedFingerprint("s2", "C:/a.ts")).toBeUndefined();
  });

  it("路径大小写不敏感（Windows）", () => {
    noteRead("s1", "C:/A.ts", { mtimeMs: 1, size: 10 });
    expect(expectedFingerprint("s1", "c:/a.ts")).toEqual({ mtimeMs: 1, size: 10 });
  });

  it("没有 sessionId 就不记（不污染别人的状态）", () => {
    noteRead(undefined, "C:/a.ts", { mtimeMs: 1, size: 10 });
    expect(expectedFingerprint(undefined, "C:/a.ts")).toBeUndefined();
  });

  it("写后更新指纹", () => {
    noteRead("s1", "C:/a.ts", { mtimeMs: 1, size: 10 });
    noteWrite("s1", "C:/a.ts", { mtimeMs: 2, size: 11 });
    expect(expectedFingerprint("s1", "C:/a.ts")).toEqual({ mtimeMs: 2, size: 11 });
  });
});
