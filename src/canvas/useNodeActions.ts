import { useCallback, useRef } from "react";
import { useReactFlow } from "@xyflow/react";
import { useRuntimeStore } from "./runtimeStore";

/**
 * 节点内部对画布的操作入口（节点渲染器只依赖这个 hook，不直接碰 store 细节）。
 *
 * 历史点策略：
 *   · `beginEdit` —— 连续输入（打字）只在首个按键处打一个撤销点，800ms 窗口内不重复打
 *   · 其余操作先打撤销点（store action）再改数据，保证 Ctrl+Z 回到改动前
 */

const EDIT_BUCKET_MS = 800;

export function useNodeActions() {
  const { updateNodeData } = useReactFlow();
  const commitHistory = useRuntimeStore((s) => s.commitHistory);
  const lastEditAt = useRef(new Map<string, number>());

  /** 连续编辑：一个输入窗口只产生一个撤销点。 */
  const beginEdit = useCallback(
    (nodeId: string) => {
      const now = Date.now();
      const last = lastEditAt.current.get(nodeId) ?? 0;
      if (now - last < EDIT_BUCKET_MS) return;
      lastEditAt.current.set(nodeId, now);
      commitHistory();
    },
    [commitHistory],
  );

  const setData = useCallback(
    (nodeId: string, patch: Record<string, unknown>) => {
      updateNodeData(nodeId, patch);
    },
    [updateNodeData],
  );

  return { beginEdit, setData };
}
