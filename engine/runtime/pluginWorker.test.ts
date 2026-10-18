import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { startIsolatedPlugin } from "./pluginWorker";

/**
 * **插件隔离进程**（G18）的判据。
 *
 * ① 正常插件：元数据能拿到、工具能调；
 * ② 工具抛错：错误如实回传，**主进程不受影响**（后续调用照常）；
 * ③ 卡死（`while(true)`）：超时后**进程被终止**，调用报错，测试进程还活着；
 * ④ 自己退出（`process.exit`）：调用报错，主进程不陪葬；
 * ⑤ 越界读文件：权限模型可用时必须拦住；不可用时 `isolation` 必须如实标成 `worker`。
 */

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* Windows 上 worker 刚退出时可能还占着：尽力而为 */
    }
  }
});

function makePlugin(body: string): { dir: string; entryUrl: string } {
  const dir = mkdtempSync(path.join(os.tmpdir(), "dh-plugin-worker-"));
  dirs.push(dir);
  writeFileSync(path.join(dir, "index.mjs"), body, "utf8");
  return { dir, entryUrl: pathToFileURL(path.join(dir, "index.mjs")).href };
}

describe("G18：插件在独立进程里跑", () => {
  it("元数据与调用：工具名/描述/schema 都拿得到，调用能返回", async () => {
    const { dir, entryUrl } = makePlugin(`
export const tools = {
  ping: { description: "回个话", inputSchema: { type: "object" }, run: async (input) => ({ ok: true, echo: input?.x ?? null }) },
};
export const hooks = { "turn:end": async () => {} };
`);
    const started = await startIsolatedPlugin({ dir, entryUrl, allowWrite: false, allowExec: false });
    expect(started.ok, started.ok ? "" : started.error).toBe(true);
    if (!started.ok) return;
    expect(started.plugin.isolation === "worker-permission" || started.plugin.isolation === "worker").toBe(true);
    expect(Object.keys(started.plugin.tools)).toEqual(["ping"]);
    expect(started.plugin.hooks).toEqual(["turn:end"]);
    await expect(started.plugin.run("ping", { x: 1 }, 3000)).resolves.toEqual({ ok: true, echo: 1 });
    started.plugin.close();
  });

  it("工具抛错 → 错误回传；进程还在（下一次调用照常）", async () => {
    const { dir, entryUrl } = makePlugin(`
export const tools = {
  boom: { description: "炸一下", inputSchema: { type: "object" }, run: async () => { throw new Error("故意失败"); } },
  ok: { description: "正常", inputSchema: { type: "object" }, run: async () => "fine" },
};
`);
    const started = await startIsolatedPlugin({ dir, entryUrl, allowWrite: false, allowExec: false });
    if (!started.ok) throw new Error(started.error);
    await expect(started.plugin.run("boom", {}, 3000)).rejects.toThrow(/故意失败/);
    await expect(started.plugin.run("ok", {}, 3000)).resolves.toBe("fine");
    started.plugin.close();
  });

  it("⭐ 卡死会超时并被终止：调用报错，主进程继续跑", async () => {
    const { dir, entryUrl } = makePlugin(`
export const tools = {
  hang: { description: "死循环", inputSchema: { type: "object" }, run: async () => { for (;;) {} } },
};
`);
    const started = await startIsolatedPlugin({ dir, entryUrl, allowWrite: false, allowExec: false });
    if (!started.ok) throw new Error(started.error);
    const t0 = Date.now();
    await expect(started.plugin.run("hang", {}, 500)).rejects.toThrow(/超时|终止/);
    const elapsed = Date.now() - t0;
    expect(elapsed, `超时没生效（用了 ${elapsed}ms）`).toBeLessThan(5000);
    /* 主进程还活着：这段代码本身就证明了（否则测试进程已经卡死） */
    started.plugin.close();
  }, 15_000);

  it("⭐ 自己 process.exit 也只死它自己", async () => {
    const { dir, entryUrl } = makePlugin(`
export const tools = {
  die: { description: "退出", inputSchema: { type: "object" }, run: async () => { process.exit(1); } },
};
`);
    const started = await startIsolatedPlugin({ dir, entryUrl, allowWrite: false, allowExec: false });
    if (!started.ok) throw new Error(started.error);
    await expect(started.plugin.run("die", {}, 3000)).rejects.toThrow();
    started.plugin.close();
  });

  it("越界读文件：权限模式必须拦住；否则 isolation 必须如实不是 worker-permission", async () => {
    const outside = mkdtempSync(path.join(os.tmpdir(), "dh-plugin-secret-"));
    dirs.push(outside);
    const secret = path.join(outside, "secret.txt");
    writeFileSync(secret, "这是插件不该读到的东西", "utf8");

    const { dir, entryUrl } = makePlugin(`
import { readFileSync } from "node:fs";
export const tools = {
  steal: {
    description: "读插件目录之外的文件",
    inputSchema: { type: "object" },
    run: async (input) => readFileSync(input.path, "utf8"),
  },
};
`);
    const started = await startIsolatedPlugin({ dir, entryUrl, allowWrite: false, allowExec: false });
    if (!started.ok) throw new Error(started.error);
    if (started.plugin.isolation === "worker-permission") {
      await expect(started.plugin.run("steal", { path: secret }, 3000)).rejects.toThrow();
    } else {
      /* 这台机器的 Node 不支持权限模型：**只能隔离崩溃，不能隔离文件** —— 必须如实标 */
      await expect(started.plugin.run("steal", { path: secret }, 3000)).resolves.toContain("不该读到");
    }
    started.plugin.close();
  });

  it("已批准 fs:write 时，只能写插件目录（写别处仍被拒）", async () => {
    const outside = mkdtempSync(path.join(os.tmpdir(), "dh-plugin-outside-"));
    dirs.push(outside);
    const { dir, entryUrl } = makePlugin(`
import { writeFileSync } from "node:fs";
export const tools = {
  put: { description: "写文件", inputSchema: { type: "object" }, run: async (input) => { writeFileSync(input.path, "x"); return "ok"; } },
};
`);
    const started = await startIsolatedPlugin({ dir, entryUrl, allowWrite: true, allowExec: false });
    if (!started.ok) throw new Error(started.error);
    if (started.plugin.isolation === "worker-permission") {
      await expect(started.plugin.run("put", { path: path.join(outside, "a.txt") }, 3000)).rejects.toThrow();
      await expect(started.plugin.run("put", { path: path.join(dir, "inside.txt") }, 3000)).resolves.toBe("ok");
      expect(readFileSync(path.join(dir, "inside.txt"), "utf8")).toBe("x");
    } else {
      await expect(started.plugin.run("put", { path: path.join(dir, "inside.txt") }, 3000)).resolves.toBe("ok");
    }
    started.plugin.close();
  });
});
