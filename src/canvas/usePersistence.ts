import { useCallback, useEffect, useRef, useState } from "react";
import type { CanvasDocument, CanvasLoadResult, ShellBridge } from "@shared/ipc";
import { useRuntimeStore } from "./runtimeStore";
import type { Marker } from "./markers";
import type { CanvasNode } from "./types";
import { droppedCount, normalizeCanvasDoc } from "./normalizeDoc";

/**
 * 持久化接线（PLAN 4.1 ~ 4.5）。
 *
 * 职责划分：本模块只管"什么时候把画布交出去、交出去之后怎么标状态"，
 * 磁盘上的原子写 / 确认 / 回退全在主进程（`electron/ipc/snapshotStore.ts`）。
 *
 * 三个时机：
 *   · 载入：启动时读一次，若发现上次异常退出就按主进程给的回退结果覆盖画布
 *   · 自动保存：画布内容变化后静默 800ms 落一次（连续输入不会每字一写）
 *   · 关窗前：再落一次，尽量把最后一笔也保住
 */

const bridge = (): ShellBridge | undefined =>
  (globalThis as unknown as { shell?: ShellBridge }).shell;

/** 保存状态（状态栏显示）。 */
export type SaveState = "idle" | "dirty" | "saving" | "saved" | "error";

/** 内容变动后多久落盘。 */
const AUTOSAVE_DELAY_MS = 800;

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

/**
 * 仅提取可序列化的部分（节点里的函数、DOM 引用一律丢掉）。
 * 画布图必须可 JSON 序列化，否则宁可显式报错，也不要写出一份读不回来的快照。
 *
 * 注意 `revision` 用的是 store 的当前值：调用方（load 之后）负责让基线一致，
 * 否则会出现"存档号比磁盘上的小"从而被主进程拒绝写入。
 */
export function serializeCanvas(input: {
  nodes: CanvasNode[];
  edges: unknown[];
  viewport: { x: number; y: number; zoom: number };
  revision: number;
  confirmedRevision: number;
  /** 标记层（阶段 5）：和节点一起进快照，否则重启后批注全丢。 */
  markers?: Marker[];
}): CanvasDocument {
  return {
    version: 2,
    revision: input.revision,
    confirmedRevision: input.confirmedRevision,
    updatedAt: new Date().toISOString(),
    viewport: { ...input.viewport },
    nodes: JSON.parse(JSON.stringify(input.nodes)) as unknown[],
    edges: JSON.parse(JSON.stringify(input.edges)) as unknown[],
    markers: JSON.parse(JSON.stringify(input.markers ?? [])) as unknown[],
  };
}

/**
 * 修订号合法性校验（PLAN 4.2）。
 * @param draft 待写入的修订号
 * @param persisted 已落盘的修订号
 * @returns 是否允许写入，以及被拒绝的原因
 */
export function validateRevision(
  draft: number,
  persisted: number,
): { ok: true } | { ok: false; reason: string } {
  if (!Number.isInteger(draft) || draft < 0) {
    return { ok: false, reason: `修订号必须是非负整数，收到 ${String(draft)}` };
  }
  if (draft < persisted) {
    return { ok: false, reason: `修订号不能倒退：${draft} < ${persisted}` };
  }
  return { ok: true };
}

export function usePersistence(): PersistenceApi {
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [savedRevision, setSavedRevision] = useState(0);
  const [recoveryNote, setRecoveryNote] = useState<string | null>(null);
  const revisionRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const savingRef = useRef(false);

  /** 把当前画布落盘并确认。 */
  const persist = useCallback(async () => {
    const shell = bridge();
    if (!shell?.canvas || savingRef.current) return;
    const state = useRuntimeStore.getState();
    const doc = serializeCanvas({
      nodes: state.nodes,
      edges: state.edges,
      viewport: state.viewport,
      revision: state.revision,
      confirmedRevision: state.revision,
      markers: state.markers,
    });
    const check = validateRevision(doc.revision, revisionRef.current);
    if (!check.ok) {
      setSaveState("error");
      console.error("[persist]", check.reason);
      return;
    }

    savingRef.current = true;
    setSaveState("saving");
    try {
      const result = await shell.canvas.save(doc);
      if (!result.ok) {
        setSaveState("error");
        console.error("[persist] 保存失败：", result.error);
        return;
      }
      revisionRef.current = doc.revision;
      setSavedRevision(doc.revision);
      // ack：告诉主进程"这一版确实写全了"，下次崩溃才不会把它当成未确认快照丢掉
      await shell.canvas.ack(doc.revision);
      setSaveState("saved");
    } catch (error) {
      setSaveState("error");
      console.error("[persist] 保存异常：", error instanceof Error ? error.message : error);
    } finally {
      savingRef.current = false;
    }
  }, []);

  const saveNow = useCallback(async () => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    await persist();
  }, [persist]);

  /** 载入：读文档 → 覆盖画布 → 处理崩溃回退。 */
  useEffect(() => {
    const shell = bridge();
    if (!shell?.canvas) return;
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
        if (doc.nodes.length > 0) {
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
        /**
         * 基线要做回退：崩溃恢复后主进程把 revision 降回了确认版，
         * 如果这里还留着崩溃前那个更大的数，下一次自动保存会因为
         * "修订号不能倒退"被主进程拒绝（实测表现为状态栏一直停在"保存失败"）。
         */
        revisionRef.current = doc.revision;
        setSavedRevision(doc.revision);
        if (result.recovered && result.recoveryNote) setRecoveryNote(result.recoveryNote);
        setSaveState("saved");
      } catch (error) {
        setSaveState("error");
        console.error("[persist] 载入失败：", error instanceof Error ? error.message : error);
      }
    })();
  }, []);

  /** 内容变化 → 延迟落盘。 */
  useEffect(() => {
    const unsubscribe = useRuntimeStore.subscribe((state, prev) => {
      if (state.revision === prev.revision) return;
      setSaveState("dirty");
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        void persist();
      }, AUTOSAVE_DELAY_MS);
    });
    return () => {
      unsubscribe();
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [persist]);

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
