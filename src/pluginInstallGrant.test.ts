import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { removeAll } from "./testFs";

/**
 * 桌面装插件**要先问权限**（**审计 P01**）。
 *
 * ## 缺陷形状
 *
 * `pluginHost.ts` 的安装 handler 原来是 `installFromNpm({paths, spec})` —— **不传 `granted`**，
 * 而 `pluginStore.installFromDir` 的规则是"不传 = 全部批准"，于是：
 * **界面点一下就把它申请的权限全批了**，下一行 `loadPluginsAtStartup()` 立刻在主进程里
 * import 执行它的代码。CLI 侧早就是两段式（读清单给用户看 → `--yes` → `--grant`），
 * 同一台机器上命令行装插件有确认、界面点一下没有。
 *
 * ## 这一组钉什么
 *
 * ① **行为**：确认框回"取消"时**什么都不许发生**（ledger 里没有它），
 *    回"安装"时才装上、且 `granted` 恰好等于清单里那一组（不多不少）；
 * ② **接线**（源码级）：handler 里必须出现确认调用，且两条渠道都传 `granted:` ——
 *    把 `granted:` 删掉、或把确认那一步删掉，这里会红。
 */
const env = vi.hoisted(() => ({ userData: "", messageBox: 1, pluginDir: "" }));

vi.mock("electron", () => ({
  app: { getPath: () => env.userData },
  dialog: {
    showOpenDialog: async () => ({ canceled: false, filePaths: [env.pluginDir] }),
    showMessageBox: async () => ({ response: env.messageBox }),
  },
  ipcMain: { handle: () => undefined },
}));

/** 一个最小但**合法**的插件目录（清单 + 入口）。 */
function makePluginDir(root: string): string {
  const dir = path.join(root, "demo-plugin-src");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, "ding-plugin.json"),
    JSON.stringify({
      name: "demo-plugin",
      version: "1.0.0",
      description: "一个演示用的插件（测试夹具）",
      permissions: ["tools:register"],
      tools: ["demo_tool"],
      engines: { ding: ">=0.1.0" },
    }),
    "utf8",
  );
  writeFileSync(path.join(dir, "index.mjs"), "export const tools = { demo_tool: () => 'ok' };\n", "utf8");
  return dir;
}

let dir = "";
/** 每个用例真的去注册一遍 IPC，把 handler 抓出来。 */
let install: (spec?: unknown) => Promise<{ ok: boolean; canceled?: boolean; errors?: string[] }>;

beforeEach(async () => {
  dir = mkdtempSync(path.join(os.tmpdir(), "dh-plugin-grant-"));
  env.userData = path.join(dir, "userData");
  mkdirSync(env.userData, { recursive: true });
  env.pluginDir = makePluginDir(dir);
  env.messageBox = 1;
  vi.resetModules();
  const handlers = new Map<string, (e: unknown, ...args: unknown[]) => Promise<unknown>>();
  const fakeIpc = {
    handle: (ch: string, fn: (e: unknown, ...args: unknown[]) => Promise<unknown>) => handlers.set(ch, fn),
  };
  const mod = await import("../electron/ipc/pluginHost");
  mod.registerPluginIpc(fakeIpc as never, () => ({}) as never);
  const fn = handlers.get("plugin:install")!;
  install = (spec?: unknown) => fn(null, spec) as Promise<{ ok: boolean; canceled?: boolean; errors?: string[] }>;
});

afterEach(() => {
  removeAll(dir);
});

const ledgerOf = () => {
  const file = path.join(env.userData, "plugins", "plugins.json");
  try {
    return JSON.parse(readFileSync(file, "utf8")) as { installed: Array<{ name: string; granted: string[] }> };
  } catch {
    return { installed: [] };
  }
};

describe("桌面安装插件要过权限确认（P01）", () => {
  it("⭐ 用户在确认框点了「取消」→ **什么都没装**（这是「装即全量授权」的正面判据）", async () => {
    env.messageBox = 1; // 取消
    const got = await install();
    expect(got.canceled).toBe(true);
    expect(got.ok).toBe(false);
    expect(ledgerOf().installed, "用户点了取消，台账里不该有它").toEqual([]);
  });

  it("⭐ 点了「安装」→ 装上了，且 `granted` 恰好是**清单里那一组**（不是「默认全批」）", async () => {
    env.messageBox = 0; // 安装
    const got = await install();
    expect(got.ok, JSON.stringify(got.errors ?? [])).toBe(true);
    const list = ledgerOf().installed;
    expect(list.length).toBe(1);
    expect(list[0]!.name).toBe("demo-plugin");
    expect(list[0]!.granted).toEqual(["tools:register"]);
  });

  it("清单读不到/不合法时：报错，且不弹确认框、不装", async () => {
    writeFileSync(path.join(env.pluginDir, "ding-plugin.json"), "{不是 JSON", "utf8");
    env.messageBox = 0;
    const got = await install();
    expect(got.ok).toBe(false);
    expect(ledgerOf().installed).toEqual([]);
  });
});

describe("接线（源码级）：两条渠道都必须带 granted", () => {
  const SRC = readFileSync(path.join(__dirname, "../electron/ipc/pluginHost.ts"), "utf8");
  const installBlock = () => {
    const from = SRC.indexOf("ipcMain.handle(PLUGIN_CHANNEL.install");
    return SRC.slice(from, SRC.indexOf("ipcMain.handle(PLUGIN_CHANNEL.setEnabled"));
  };

  it("⭐ 安装 handler 里真的调了权限确认（删掉那一步就红）", () => {
    expect(installBlock(), "安装 handler 里没有权限确认调用").toContain("confirmInstall(");
  });

  it("⭐ 两条渠道都把用户看到的那一组传下去（`granted:` 一个都不能少）", () => {
    const block = installBlock();
    const grantedCalls = block.match(/granted:/g) ?? [];
    expect(grantedCalls.length, "installFromTarball / installFromDir 各要传一次 granted").toBeGreaterThanOrEqual(2);
    expect(block).toContain("installFromTarball(");
    expect(block).toContain("installFromDir(");
  });

  it("确认框 fail-closed：没有窗口时不装（`confirmInstall` 里那一条）", () => {
    const fn = SRC.slice(SRC.indexOf("async function confirmInstall"), SRC.indexOf("function checkedManifestOf"));
    expect(fn, "没有窗口时应当 fail-closed（问不了 = 不许默认同意）").toContain("if (!win) return false");
  });
});
