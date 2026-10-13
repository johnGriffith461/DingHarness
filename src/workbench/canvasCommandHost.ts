import { useRuntimeStore } from "@/canvas/runtimeStore";
import { useWorkbenchStore } from "./store";
import type { CanvasCommand, CanvasCommandResult, ShellBridge } from "@shared/ipc";

/**
 * 画布命令的**执行端**（§146）。
 *
 * ## 为什么命令要从主进程发过来
 *
 * 工具（`canvas_add_node`）跑在**主进程**，而**画布文档由渲染进程持有**
 * （主进程只管落盘与版本历史）。主进程直接改文档会被渲染侧的自动保存覆盖 ——
 * 那是会丢数据的做法。
 *
 * 所以走"主进程发命令 → 渲染进程动手 → 回执"这条路：
 * 工具能拿到**确定的成败**，而不是"我发了个通知，大概成了吧"。
 *
 * ⚠️ 每一步都要回执，**包括失败**。只在成功时回执的话，主进程要等到 5 秒超时，
 * 用户看到的是"卡了一下然后说没成功"，而真正的原因（比如画布没挂起来）丢了。
 */

const bridge = (): ShellBridge | undefined => (globalThis as unknown as { shell?: ShellBridge }).shell;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * 起监听。在根组件挂载时调一次。
 *
 * @returns 取消订阅
 */
export function startCanvasCommandHost(): () => void {
  const shell = bridge();
  if (!shell?.canvas?.onCommand) return () => undefined;

  const off = shell.canvas.onCommand((raw) => {
    const cmd = raw as CanvasCommand;
    const reply = (result: Omit<CanvasCommandResult, "id">): void => {
      void shell.canvas.commandResult({ id: cmd?.id ?? "", ...result });
    };

    void (async () => {
      try {
        const wb = useWorkbenchStore.getState();
        let opened = false;
        if (!wb.canvasOpen) {
          // 画布没开：先打开它（用户看到的是"画布自己开了"，所以回执里带上 opened）
          wb.toggleCanvas();
          opened = true;
          // 等它挂载：画布是条件渲染的，紧接着拿 store 会拿到还没初始化的那份
          await sleep(400);
        }

        const rt = useRuntimeStore.getState();
        // 依次摆放，别叠在同一个点上
        const n = rt.nodes.length;
        const at = { x: 420 + (n % 3) * 260, y: 280 + Math.floor(n / 3) * 200 };
        const node = rt.addNodeAt(cmd.kind, at);

        /*
         * 按类型写内容。
         * `markdown` 的字段是 `text`、`code` 的是 `code` —— 这两个是**核实过**的
         * （`src/canvas/types.ts` 的 MarkdownData / CodeData）。
         * 节点类型就先只放开这两种：其余类型的字段名没核实，放出去只会写错字段。
         */
        rt.patchNodeData(node.id, cmd.kind === "code" ? { code: cmd.text, lang: cmd.lang ?? "text" } : { text: cmd.text });
        rt.selectNodes([node.id]);
        rt.commitHistory();

        reply({ ok: true, nodeId: node.id, opened });
      } catch (error) {
        reply({ ok: false, error: error instanceof Error ? error.message : String(error) });
      }
    })();
  });

  return off;
}
