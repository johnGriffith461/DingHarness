import { useCallback, useEffect, useRef, useState } from "react";
import type { CanvasLoadResult, ShellBridge } from "@shared/ipc";
import { useRuntimeStore } from "./runtimeStore";
import type { Marker } from "./markers";
import type { CanvasNode } from "./types";
import { droppedCount, normalizeCanvasDoc } from "./normalizeDoc";
import {
  AUTOSAVE_DELAY_MS,
  createCanvasSaver,
  shouldApplyLoadedDoc,
  type CanvasSink,
  type SaveState,
} from "./canvasSaver";
import { markCanvasLoaded, resetCanvasLoadGate } from "./loadGate";

/**
 * 持久化接线（PLAN 4.1 ~ 4.5）。
 *
 * 职责划分：本模块只管**什么时候**把画布交出去（定时器 / 订阅 / 关窗前），
 * 以及把载入结果放进 store；**写什么、写完记哪个数**在 `canvasSaver.ts`（纯逻辑、可单测），
 * 磁盘上的原子写 / 版本迁移 / 确认 / 回退全在主进程（`electron/ipc/snapshotStore.ts`）。
 *
 * 三个时机：
 *   · 载入：启动时读一次，若发现上次异常退出就按主进程给的回退结果覆盖画布
 *   · 自动保存：画布内容变化后静默 800ms 落一次（连续输入不会每字一写）
 *   · 关窗前：再落一次，尽量把最后一笔也保住
 */

const bridge = (): ShellBridge | undefined =>
  (globalThis as unknown as { shell?: ShellBridge }).shell;

export type PersistenceApi = {
  saveState: SaveState;
  /** 最近一次保存的修订号。 */
  savedRevision: number;
  /** 载入时若发生崩溃回退，这里给出提示文案。 */
  recoveryNote: string | null;
  clearRecoveryNote: () => void;
  /** 手动保存（工具栏/快捷键用）。 */
  saveNow: () => Promise<void>;
};

/* ⚠️ 序列化 / 修订号校验 / "载入的文档要不要覆盖" 都搬进了 `canvasSaver.ts`
 *（P16/P17/P29 那三条要能被单测钉住）。这里原样再导出，调用方与既有测试一个字不用改。 */
export { serializeCanvas, validateRevision, shouldApplyLoadedDoc, AUTOSAVE_DELAY_MS } from "./canvasSaver";
/** `SaveState` 一并再导出：`CanvasStatusBar` 按这个名字从本文件取它。 */
export type { SaveState } from "./canvasSaver";

export function usePersistence(): PersistenceApi {
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [savedRevision, setSavedRevision] = useState(0);
  const [recoveryNote, setRecoveryNote] = useState<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  /**
   * 写盘器：跟着组件活一次（`useRef` 里那份）。
   *
   * ⚠️ 惰性建（不能每次渲染都建）：它持有"已落盘 / 已确认"两个数，重建就等于把基线忘了。
   */
  const saverRef = useRef<ReturnType<typeof createCanvasSaver> | null>(null);
  if (saverRef.current === null) {
    saverRef.current = createCanvasSaver({
      api: (): CanvasSink | undefined => {
        const canvas = bridge()?.canvas;
        if (!canvas) return undefined;
        return {
          save: (doc) => canvas.save(doc),
          ack: (revision) => canvas.ack(revision),
        };
      },
      read: () => {
        const state = useRuntimeStore.getState();
        return {
          nodes: state.nodes,
          edges: state.edges,
          viewport: state.viewport,
          markers: state.markers,
          revision: state.revision,
        };
      },
      onState: setSaveState,
      onError: (reason) => console.error("[persist]", reason),
    });
  }
  const saver = saverRef.current;

  const saveNow = useCallback(async () => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    /*
     * ⚠️ 手动保存要等**正在跑的那一次**写完，然后再落一次最新的（P17）：
     * `saver.save()` 在忙时会排队（不会静默丢掉），所以这里只要等它做完。
     */
    await saver.save();
    await saver.idle();
    setSavedRevision(saver.persisted());
  }, [saver]);

  /** 载入：读文档 → 覆盖画布 → 处理崩溃回退。 */
  useEffect(() => {
    const shell = bridge();
    /*
     * ⚠️ 载入闸（P74）：每次挂载都**重开一次**，然后在所有出口处放行 ——
     * 「AI 往画布加节点」那条命令要靠它等到"载入真的回来了"，而不是赌 400ms。
     */
    resetCanvasLoadGate();
    if (!shell?.canvas) {
      markCanvasLoaded();
      return;
    }
    const load: () => Promise<CanvasLoadResult> = shell.canvas.load;
    void (async () => {
      try {
        const result = await load();
        /*
         * ⚠️ 先把落盘的文档**洗一遍**再进画布（§181）。
         *
         * 原来这里是三句裸断言（`as CanvasNode[]` / `as never[]` / `as Marker[]`）——
         * 一个手改过的、或旧版本的 `document.json` 会直接进到 react-flow：
         * 节点缺 `position`、连线指向不存在的节点，**轻则一堆烂节点，重则整块画布打不开**。
         *
         * 取舍写在 `normalizeCanvasDoc` 里：**宁可挪位置，不可丢内容**。
         */
        const doc = normalizeCanvasDoc(result.doc);
        /*
         * ⚠️ **空画布也要照载**（2026-10-16 审计 P16）。
         *
         * 原来这里是 `if (doc.nodes.length > 0)` —— 于是"用户自己清空过"与
         * "全新安装（磁盘上还没有存档）"被当成同一种：前者会被示例图盖回来，
         * 而且基线（`revisionRef`）已经跟着磁盘走了，store 里的修订号还停在 0，
         * **之后每一次保存都被"修订号不能倒退"拒掉**（状态栏永久停在保存失败）。
         * 区分两种情形的判据写在 `shouldApplyLoadedDoc` 里（含理由）。
         */
        if (shouldApplyLoadedDoc(doc)) {
          useRuntimeStore.getState().loadDocument({
            nodes: doc.nodes,
            edges: doc.edges,
            viewport: doc.viewport,
            revision: doc.revision,
            markers: doc.markers,
          });
        }
        /* 丢过东西就说一句（静默吞掉最坏：用户以为自己的东西没了） */
        if (droppedCount(doc) > 0) {
          setRecoveryNote(`有 ${droppedCount(doc)} 个元素读不进来（数据不完整或版本不对），已跳过`);
        }
        /*
         * 基线要做回退：崩溃恢复后主进程把 revision 降回了确认版，
         * 如果这里还留着崩溃前那个更大的数，下一次自动保存会因为
         * "修订号不能倒退"被主进程拒绝（实测表现为状态栏一直停在"保存失败"）。
         *
         * ⚠️ `confirmedRevision` 也要一起对齐（P29）：它是**主进程认的"写到哪儿了"**，
         * 写盘时交给主进程的那个数从这里来（初始化为 0 是对的 —— 全新安装时
         * 磁盘上那份是 `emptyDocument()`，本来就没有任何已确认的修订）。
         */
        saver.adopt(doc.revision, result.doc.confirmedRevision ?? 0);
        setSavedRevision(doc.revision);
        if (result.recovered && result.recoveryNote) setRecoveryNote(result.recoveryNote);
        setSaveState("saved");
      } catch (error) {
        setSaveState("error");
        console.error("[persist] 载入失败：", error instanceof Error ? error.message : error);
      } finally {
        /* 无论成没成都要放行：等待方可能是"AI 往画布加节点"那条命令，它只要知道"尘埃落定" */
        markCanvasLoaded();
      }
    })();
  }, [saver]);

  /** 内容变化 → 延迟落盘。 */
  useEffect(() => {
    const unsubscribe = useRuntimeStore.subscribe((state, prev) => {
      if (state.revision === prev.revision) return;
      setSaveState("dirty");
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        void saver.save();
      }, AUTOSAVE_DELAY_MS);
    });
    return () => {
      unsubscribe();
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [saver]);

  /** 关窗前再落一次，尽量保住最后一笔。 */
  useEffect(() => {
    const onBeforeUnload = () => {
      void saveNow();
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [saveNow]);

  const clearRecoveryNote = useCallback(() => setRecoveryNote(null), []);

  return { saveState, savedRevision, recoveryNote, clearRecoveryNote, saveNow };
}

/** 标记类型在本文件里被 re-export 出去过（既有调用方按这个名字引）。 */
export type { Marker, CanvasNode };
