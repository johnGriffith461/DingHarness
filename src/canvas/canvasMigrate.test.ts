import { describe, expect, it } from "vitest";
import { CANVAS_VERSION, migrateCanvasDoc, type CanvasDocument } from "@shared/canvas";

/**
 * C1：画布文档的**前向迁移**。
 *
 * 这条守卫补的是一个"看着有、其实没用"的洞：`emptyDocument()` 一直写 `version: 2`，
 * 而**没有任何代码读过这个版本号** —— 于是"结构变了才 +1"这条规矩从来没有落点。
 * 现在它有了，而且必须能红（把任一条断言反过来就会失败）。
 */
const empty = (): CanvasDocument => ({
  version: CANVAS_VERSION,
  revision: 0,
  confirmedRevision: 0,
  viewport: { x: 0, y: 0, zoom: 1 },
  nodes: [],
  edges: [],
  markers: [],
});

describe("migrateCanvasDoc", () => {
  it("⭐ 缺 version 的旧文件当作第 1 版，并补上标记层（不丢内容）", () => {
    const old = { revision: 7, confirmedRevision: 7, viewport: { x: 1, y: 2, zoom: 1 }, nodes: [{ id: "n1" }], edges: [] };
    const got = migrateCanvasDoc(old, empty);
    expect(got.from).toBe(1);
    expect(got.migrated).toBe(true);
    expect(got.foreign).toBe(false);
    expect(got.doc.version).toBe(CANVAS_VERSION);
    expect(got.doc.markers).toEqual([]);
    // 内容一个都不许少
    expect(got.doc.nodes).toEqual([{ id: "n1" }]);
    expect(got.doc.revision).toBe(7);
  });

  it("version: 1 → 升到当前版，同样补标记层", () => {
    const got = migrateCanvasDoc({ version: 1, revision: 1, confirmedRevision: 1, viewport: { x: 0, y: 0, zoom: 1 }, nodes: [], edges: [] }, empty);
    expect(got.migrated).toBe(true);
    expect(got.doc.version).toBe(CANVAS_VERSION);
  });

  it("已经是当前版 → 原样返回，且**不重写**（不制造「每次启动都迁一遍」）", () => {
    const doc = { ...empty(), revision: 3, confirmedRevision: 3, markers: [{ id: "m1" }] };
    const got = migrateCanvasDoc(doc, empty);
    expect(got.migrated).toBe(false);
    expect(got.from).toBe(CANVAS_VERSION);
    expect(got.doc.markers).toEqual([{ id: "m1" }]);
  });

  it("旧文件里已经有标记层 → 保留它，不许被空数组顶掉", () => {
    const got = migrateCanvasDoc({ version: 1, markers: [{ id: "m9" }], nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 } }, empty);
    expect(got.doc.markers).toEqual([{ id: "m9" }]);
  });

  it("⚠️ 版本比本代码新 → foreign=true，但**内容照给**（画布是用户看得见的东西）", () => {
    const future = { ...empty(), version: 99, revision: 5, confirmedRevision: 5 };
    const got = migrateCanvasDoc(future, empty);
    expect(got.foreign).toBe(true);
    expect(got.migrated).toBe(false);
    expect(got.doc.revision).toBe(5); // 没有换成空文档
    expect(got.note).toContain("99");
  });

  it("不是对象（数组 / null / 字符串）→ 给空文档，不抛", () => {
    for (const raw of [null, undefined, [], "x", 42]) {
      const got = migrateCanvasDoc(raw, empty);
      expect(got.migrated).toBe(false);
      expect(got.foreign).toBe(false);
      expect(got.doc.version).toBe(CANVAS_VERSION);
    }
  });
});
