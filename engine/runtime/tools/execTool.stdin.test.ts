import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";

import { describeRunResult, runCommandForModel } from "./execTool";

/**
 * B-02：`run_command` 的 stdin。
 *
 * ## 为什么要它
 *
 * 判据四写得很直白："需要输入的命令能拿到输入并跑完"。
 * 没有 stdin 参数时，`npm init` 这类命令在模型手里只能靠默认值，
 * 真正需要喂输入的脚本（登录、交互式初始化、读 stdin 的校验）根本没法用。
 *
 * ## 口径（这里固定下来）
 *
 * **总是 `end()`**：给了 stdin 就写进去再关；没给也关（EOF）。
 * 理由：子进程若继承父进程的 stdin，它会和 CLI 的审批提问抢同一份输入 ——
 * 而 `run_command` 跑的东西是模型写的，不该有机会读用户的终端。
 */
type FakeChild = EventEmitter & {
  pid: number;
  stdout: EventEmitter;
  stderr: EventEmitter;
  stdin: { end: (value?: string) => void };
  killed: boolean;
  kill: () => void;
};

function fakeSpawn() {
  const ends: Array<string | undefined> = [];
  const spawnImpl = (() => {
    const child = new EventEmitter() as FakeChild;
    child.pid = 4242;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.killed = false;
    child.kill = () => {
      child.killed = true;
    };
    child.stdin = {
      end: (value?: string) => {
        ends.push(value);
      },
    };
    setImmediate(() => child.emit("close", 0));
    return child;
  }) as unknown as typeof import("node:child_process").spawn;
  return { spawnImpl, ends };
}

const DIRS = ["C:/work/repo"];

describe("B-02 · run_command 的 stdin", () => {
  it("给了 stdin → 原文写进去并关闭", async () => {
    const { spawnImpl, ends } = fakeSpawn();
    const result = await runCommandForModel({ command: "node x.js", stdin: "hello\n" }, DIRS, spawnImpl);
    expect(result.ok).toBe(true);
    expect(ends).toEqual(["hello\n"]);
  });

  it("没给 stdin → 也关闭（EOF），不继承父进程的输入", async () => {
    const { spawnImpl, ends } = fakeSpawn();
    await runCommandForModel({ command: "node x.js" }, DIRS, spawnImpl);
    expect(ends).toEqual([undefined]);
  });

  it("超过 64 KiB → 拒绝，并给出可读原因（不静默截断）", async () => {
    const { spawnImpl, ends } = fakeSpawn();
    const huge = "x".repeat(64 * 1024 + 1);
    const result = await runCommandForModel({ command: "node x.js", stdin: huge }, DIRS, spawnImpl);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("64 KiB");
    expect(ends, "被拒绝的输入不该写进子进程").toEqual([]);
  });

  it("describeRunResult 在用了 stdin 时说明喂了多少", () => {
    const line = describeRunResult(
      { ok: true, command: "node x.js", cwd: DIRS[0]!, exitCode: 0, output: "ok", truncated: false, timedOut: false, sandboxed: false },
      "node x.js",
      { stdinChars: 6 },
    );
    expect(line).toContain("已喂入 6 字");
  });

  it("没用 stdin 时那句话不变（老调用零漂移）", () => {
    const base = { ok: true as const, command: "node x.js", cwd: DIRS[0]!, exitCode: 0, output: "ok", truncated: false, timedOut: false, sandboxed: false };
    expect(describeRunResult(base, "node x.js")).toBe(describeRunResult(base, "node x.js", {}));
  });
});
