import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * 画布这一片的**接线守卫**（2026-10-16）。
 *
 * 行为判据在各自的纯逻辑测试里（`canvasSaver` / `frameAdoption` / `keyDelete` / `changePolicy` /
 * `textCommit` / `frameWait`）。这一份盯的是另一半 —— **那些判据有没有被真的接上**：
 * 纯函数写得再对，只要组件/宿主不调它，产品仍然是坏的（本仓 G53 那批"恒真断言"
 * 就是这个形状：测的东西跟界面用的是两份）。
 *
 * 说明：这里读源码断言的是**接线**（谁调谁），不是行为；行为由上面那些文件 + 验收脚本挡。
 */

const ROOT = path.resolve(__dirname, "..", "..");
/** 去掉注释之后的源码（免得注释里提到的旧写法把守卫自己骗了）。 */
function source(rel: string): string {
  const text = readFileSync(path.join(ROOT, rel), "utf8");
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

describe("P16/P17/P29：画布落盘走 canvasSaver，不再自己攒一套", () => {
  const persist = source("src/canvas/usePersistence.ts");

  it("⭐ 用 `shouldApplyLoadedDoc` 判「载不载入」，而不是「有节点才载」", () => {
    expect(persist, "空画布会被示例图盖回来，且基线错位后保存永久失败（P16）").toContain("shouldApplyLoadedDoc(");
    expect(
      /if\s*\(\s*doc\.nodes\.length\s*>\s*0\s*\)/.test(persist),
      "又写成「有节点才载入」了 —— 用户自己清空过的画布会被示例图盖回来（P16）",
    ).toBe(false);
  });

  it("⭐ 没有 `savingRef` 那种「正在写就直接 return」的单值早退（P17）", () => {
    expect(persist, "第二次请求被静默丢掉 = 关窗前那次保存白做（P17）").not.toMatch(/savingRef/);
    expect(persist, "落盘交给 canvasSaver（它负责排队）").toContain("createCanvasSaver(");
  });

  it("⭐ `confirmedRevision` 由 saver 按「已确认」写，组件不再自己算（P29）", () => {
    expect(persist, "组件里又出现 confirmedRevision: state.revision 了 —— 回退分支会再次永不可达").not.toMatch(
      /confirmedRevision\s*:\s*state\.revision|confirmedRevision\s*:\s*revision\b/,
    );
    expect(persist, "载入之后要把磁盘上的确认号对齐进去").toContain("saver.adopt(");
  });

  it("载入闸：每次挂载重开、所有出口放行（P74）", () => {
    expect(persist).toContain("resetCanvasLoadGate()");
    expect(persist).toContain("markCanvasLoaded()");
    /* 早退分支（没有桥）也得放行，否则等它的人白等 */
    const early = persist.slice(persist.indexOf("resetCanvasLoadGate()"), persist.indexOf("const load:"));
    expect(early, "没有画布桥时早退却没放行 —— 等载入的那条命令会等到超时").toContain("markCanvasLoaded()");
  });
});

describe("P74：命令宿主等的是「载入完成」这件事，不是 400ms", () => {
  const host = source("src/workbench/canvasCommandHost.ts");

  it("⭐ 不许再 `sleep(400)` 赌一把", () => {
    expect(host, "又赌时间了：载入超过那个数时刚建的节点会被 loadDocument 整块冲掉").not.toMatch(/sleep\(/);
    expect(host, "要等载入闸").toContain("waitCanvasLoaded(");
  });

  it("超时要**如实回执失败**，不能假装成功", () => {
    const block = host.slice(host.indexOf("waitCanvasLoaded("));
    expect(block.slice(0, 400), "等超了还往下建节点 → 回执说 ok 而节点被冲掉").toMatch(/ok:\s*false/);
  });
});

describe("P26：版本历史恢复也要过一遍清洗", () => {
  const panel = source("src/canvas/VersionHistoryPanel.tsx");

  it("⭐ 不许再拿 `as CanvasNode[]` / `as never[]` 裸断言历史快照", () => {
    expect(panel, "绕过 normalizeCanvasDoc 了 —— 旧版本的快照会直接进 react-flow（P26）").toContain(
      "normalizeCanvasDoc(",
    );
    expect(/as never\[\]/.test(panel), "`as never[]` 又回来了").toBe(false);
  });
});

describe("P75：导出前的等帧必须有上限", () => {
  const runtime = source("src/canvas/CanvasRuntime.tsx");

  it("⭐ 不许再用「双 rAF 无超时」那个写法", () => {
    expect(
      /requestAnimationFrame\(\(\)\s*=>\s*requestAnimationFrame\(r\)\)/.test(runtime),
      "窗口被盖住时 rAF 不回调 → 这个 await 永不返回 → 浮层永远停在隐藏态（P75）",
    ).toBe(false);
    expect(runtime).toContain("waitFramesOrTimeout(");
  });
});

describe("P73：图层与版本历史两个面板互斥", () => {
  const runtime = source("src/canvas/CanvasRuntime.tsx");

  it("⭐ 开一个要关掉另一个（它们几何重叠）", () => {
    const versionsToggle = runtime.slice(runtime.indexOf("onToggleVersions"), runtime.indexOf("layersOpen={layersOpen}"));
    const layersToggle = runtime.slice(runtime.indexOf("onToggleLayers"), runtime.indexOf("onExport={onExportOrReveal}"));
    expect(versionsToggle, "开版本历史没关图层 —— 后开的会把先开的整块盖住（P73）").toContain("setLayersOpen(false)");
    expect(layersToggle, "开图层没关版本历史").toContain("setVersionsOpen(false)");
  });
});

describe("P22 / P106：两个判定必须真的接在 React Flow 的回调上", () => {
  const runtime = source("src/canvas/CanvasRuntime.tsx");

  it("⭐ `replace` 不再当结构性变更（打字一个键一个撤销点）", () => {
    expect(runtime, "onNodesChange 里又手写了一遍判定 —— 那正是它漂掉的地方").toContain("nodesAreStructural(");
    expect(/type === "remove"\s*\|\|\s*c\.type === "replace"/.test(runtime), "replace 又被算成结构性了（P22）").toBe(
      false,
    );
  });

  it("⭐ 删除键的两段都接上了（过滤连带 + 救孤儿）", () => {
    expect(runtime, "没有 onBeforeDelete：选中画框按 Delete 会连带删掉框里的卡片（P106）").toContain(
      "onBeforeDelete={onBeforeDelete}",
    );
    expect(runtime, "没有 onNodesDelete：被救下的卡片会留着悬空 parentId").toContain(
      "onNodesDelete={onNodesDelete}",
    );
    /* 两段的实现搬进 `useKeyDelete.ts`（接线与总装分开，也让这个文件的行数回到上限内） */
    expect(runtime, "两段处理要由 useKeyDelete 提供").toContain("useKeyDelete()");
    const hook = source("src/canvas/useKeyDelete.ts");
    expect(hook, "待删集没过滤（连带进来的子节点会一起删掉）").toContain("pickKeyDelete(");
    expect(hook, "被救下的子节点没接回顶层").toContain("adoptOrphans(");
  });
});
