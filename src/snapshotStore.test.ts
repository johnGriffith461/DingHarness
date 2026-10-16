import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CANVAS_VERSION } from "@shared/canvas";
import { documentStatus, loadDocument, saveDocument, snapshotDir } from "../electron/ipc/snapshotStore";
import { removeAll } from "./testFs";

/**
 * 画布快照的**坏文件处置**（P15）。
 *
 * 症状：`document.json` 在、但读不动（半截 JSON / 手改坏）时，旧实现一律当"没有文件"，
 * 于是启动读成空画布、紧接着的自动保存把一份空文档**覆盖**上去 —— 用户那份快照就没了。
 *
 * 现在的判据有两条，缺一都不算修完：
 *   ① 读坏时**不许**覆盖（`saveDocument` 明确拒绝）；
 *   ② 启动路径把坏文件**另存**一份再继续（一个字节都不丢），并且**说出来**（`recovered`）。
 */

const env = { userData: "" };

vi.mock("electron", () => ({
  app: {
    getPath: (what: string) => {
      if (what === "userData") return env.userData;
      throw new Error(`测试里没有 mock 的路径：${what}`);
    },
  },
}));

function docFile(): string {
  return path.join(snapshotDir(), "document.json");
}

/** 一份最小的合法文档。 */
function doc(patch: Record<string, unknown> = {}) {
  return {
    version: CANVAS_VERSION,
    revision: 1,
    confirmedRevision: 1,
    updatedAt: new Date().toISOString(),
    viewport: { x: 0, y: 0, zoom: 1 },
    nodes: [],
    edges: [],
    markers: [],
    ...patch,
  } as never;
}

beforeEach(() => {
  env.userData = fs.mkdtempSync(path.join(os.tmpdir(), "dh-snap-"));
  fs.mkdirSync(snapshotDir(), { recursive: true });
});

afterEach(() => {
  removeAll(env.userData);
});

describe("画布快照：坏文件不许被当成「空画布」覆盖（P15）", () => {
  it("① 文件在但读不动时 saveDocument **拒绝覆盖**（不是静默当新装用户）", () => {
    const bad = "{ 这不是合法 json";
    fs.writeFileSync(docFile(), bad, "utf8");

    const res = saveDocument(doc({ revision: 2 }));
    expect(res.ok, "坏文件被当空画布覆盖了").toBe(false);
    if (res.ok) return;
    expect(res.error).toContain("读不动");
    // 磁盘上一个字节都没动
    expect(fs.readFileSync(docFile(), "utf8")).toBe(bad);
  });

  it("② 启动路径把坏文件**另存**一份再继续，并如实说「回退了」", () => {
    const bad = "{ 半截 JSON（用户手改坏了）";
    fs.writeFileSync(docFile(), bad, "utf8");

    const got = loadDocument();
    expect(got.doc.nodes).toEqual([]);
    expect(got.recovered, "坏文件被静默当成新装用户（数据看起来全没了）").toBe(true);
    expect(got.recoveryNote ?? "").toContain("画布文件读不动");

    // 原始内容**完整地**留在 .corrupt-* 里
    const moved = fs.readdirSync(snapshotDir()).filter((f) => /^document\.json\.corrupt-.*\.json$/.test(f));
    expect(moved.length).toBe(1);
    expect(fs.readFileSync(path.join(snapshotDir(), moved[0]), "utf8")).toBe(bad);

    // 挪开之后，新的保存能正常落盘（用户不会永久卡在"保存失败"）
    const res = saveDocument(doc({ revision: 3 }));
    expect(res.ok).toBe(true);
    expect(documentStatus().revision).toBe(3);
  });

  it("③ 文件**真的**不存在时仍算新装用户（不要把 missing 也当 corrupt）", () => {
    const got = loadDocument();
    expect(got.recovered).toBe(false);
    expect(documentStatus().revision).toBe(0);
  });
});
