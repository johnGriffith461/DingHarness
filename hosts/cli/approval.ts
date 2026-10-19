import type { ExecutorContext } from "../../engine/ports/executor";
import { signatureOf } from "../../engine/runtime/stall";
import { toolArgsSummary, toolLabel } from "../../shared/agentTools";
import type { ConfirmMode } from "../../shared/ipc";

/**
 * A-03：CLI 的**就地审批**。
 *
 * ## 它解决什么
 *
 * 桌面把 `ask` 变成一张卡片，等用户点；CLI 没有卡片，只有一个终端。
 * 在它之前，CLI 遇到 `ask` 只会打一行"⏸ 等你确认（还没执行）"然后退出 0 ——
 * 用户以为命令跑完了，磁盘上什么都没变。
 *
 * ## 边界（写死在这里，不散到各处）
 *
 * - `y` / `a` / `n`（大小写不敏感）；**空行与乱写都算拒绝**（默认安全）；
 * - 非 TTY（管道 / CI）：**不读 stdin**（读了会卡死或吃掉脚本的输入），
 *   打一行可照做的提示并拒绝；
 * - 同一个调用只问一次；`allow-always` 记进会话级集合，同签名的后续调用直接放行；
 * - 问题写 **stderr**：stdout 是结果（配 `--json` 时必须保持纯净）。
 */

export type CliApprover = NonNullable<ExecutorContext["approve"]>;
export type ApprovalVerdict = Awaited<ReturnType<CliApprover>>;

/** 无头环境那句提示（测试与文档引用同一句）。 */
export const HEADLESS_DENY_HINT =
  "无头环境无法确认。要么加 --mode allow（会直接执行），要么在终端里跑同一条命令。";

export type CliApproverOptions = {
  input: NodeJS.ReadableStream & { isTTY?: boolean };
  output: NodeJS.WritableStream;
  /** 缺省按 `input.isTTY`；测试会显式给。 */
  interactive?: boolean;
  /** 会话级"总是允许"的签名集合（同一个 Set 跨多次调用复用）。 */
  remember?: Set<string>;
  /** 当前档位（只用于渲染那句话，不影响判定）。 */
  mode?: ConfirmMode;
};

/** 一次调用在终端里长什么样（返回一行，不含提示符）。 */
export function describeApproval(name: string, input: unknown): string {
  const label = toolLabel(name);
  const args = toolArgsSummary(name, input);
  return args ? `${label} ${args}` : label;
}

export function createCliApprover(opts: CliApproverOptions): CliApprover {
  const input = opts.input;
  const output = opts.output;
  const interactive = opts.interactive ?? Boolean(input.isTTY);
  const remember = opts.remember ?? new Set<string>();
  /** 这一次进程里每个签名最后得到的答案（防同一个调用问两次）。 */
  const answered = new Map<string, ApprovalVerdict>();
  /** readline 一次只能问一句：并发工具调用排成队，不交叉。 */
  let queue: Promise<unknown> = Promise.resolve();

  /**
   * 读一行。
   *
   * 不用 `readline`：它在**已经结束的流**上会立刻 close（测试里预写好的输入
   * 就是这样），于是问题还没问就被当成空行。直接挂 `data` 监听更可控 ——
   * 预缓冲的数据会在挂上监听时补发，而"流已结束"也能拿它已经攒下的半行。
   * 拿到答案后**摘掉监听并暂停流**：不把终端后续输入抢走。
   */
  const ask = (question: string): Promise<string> => {
    const next = queue.then(
      () =>
        new Promise<string>((resolve) => {
          output.write(question);
          let buffer = "";
          let settled = false;
          const cleanup = () => {
            input.off("data", onData);
            input.off("end", onEnd);
            try {
              input.pause?.();
            } catch {
              /* TTY 已经关了 */
            }
          };
          const finish = (line: string) => {
            if (settled) return;
            settled = true;
            cleanup();
            resolve(line);
          };
          const onData = (chunk: Buffer | string) => {
            buffer += String(chunk);
            const at = buffer.indexOf("\n");
            if (at >= 0) finish(buffer.slice(0, at).replace(/\r$/, ""));
          };
          const onEnd = () => finish(buffer.replace(/\r$/, ""));
          input.on("data", onData);
          input.on("end", onEnd);
          /*
           * stdin 可能**在我们挂监听之前就已经 EOF**（管道只写了一行、后面的
           * 询问没有输入了）。Node 的流不会把 `end` 重放给后来者 —— 不补这一判，
           * 第二次询问会一直等到看门狗（实测挂了 120 秒）。EOF = 没人回答 = 拒绝。
           */
          const maybeEnded = input as unknown as { readableEnded?: boolean; destroyed?: boolean };
          if (maybeEnded.readableEnded || maybeEnded.destroyed) {
            finish("");
            return;
          }
          /* 预缓冲的数据要有人读才会流出来 */
          input.resume?.();
        }),
    );
    queue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  };

  return async (req) => {
    const key = signatureOf(req.name, req.input);
    const prior = answered.get(key);
    if (prior) return prior;
    if (remember.has(key)) {
      answered.set(key, "allow-always");
      return "allow-always";
    }

    if (!interactive) {
      output.write(`${HEADLESS_DENY_HINT}\n`);
      answered.set(key, "deny");
      return "deny";
    }

    const where = opts.mode ? `（当前档位「${opts.mode}」）` : "";
    output.write(`⏸ ${describeApproval(req.name, req.input)}${where}\n`);
    const answer = (await ask("  允许一次 [y] / 本次会话总是允许 [a] / 拒绝 [n] ")).trim().toLowerCase();
    const verdict: ApprovalVerdict = answer === "y" ? "allow" : answer === "a" ? "allow-always" : "deny";
    if (verdict === "allow-always") remember.add(key);
    answered.set(key, verdict);
    return verdict;
  };
}
