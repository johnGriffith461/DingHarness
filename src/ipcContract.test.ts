import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * 守卫：**渲染层调的每个通道，主进程都得有人接**（2026-10-16，审计 P93）。
 *
 * ## 这条补的是哪一格
 *
 * `electron/preload.ts` 末尾有一句 `} satisfies ShellBridge;` —— 它只钉住了
 * "桥与契约这一对"。另外两对**没人钉**：渲染层调了什么（= 桥暴露的方法）
 * ↔ 主进程 `ipcMain.handle` 接了什么。于是漂了也没人知道。
 *
 * 判据（机械、可判定）：
 *   ① 把 `electron/preload.ts` 里所有 `ipcRenderer.invoke/send(通道)` 收集出来
 *      （字面量通道 + `CONST.键` 形式的通道都解析成字符串）；
 *   ② 把 `electron/` 下所有 `ipcMain.handle/on(通道)` 收集出来（同样两种形式）；
 *   ③ **每一次调用都要有对应的接** —— 少一个就是"点了没反应"（而且是整块功能）。
 *
 * 反向（接了没人调）只作为**信息**打印：有些 handler 是给别处留的口子，
 * 直接判红会逼人写假代码去迎合它。
 */

const ROOT = path.resolve(__dirname, "..");
const PRELOAD = path.join(ROOT, "electron", "preload.ts");

/** 递归列 .ts 文件（跳过测试）。 */
function tsFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === "node_modules") continue;
      tsFiles(full, out);
    } else if (name.endsWith(".ts") && !name.endsWith(".test.ts")) {
      out.push(full);
    }
  }
  return out;
}

/**
 * 收集"通道常量对象"里键 → 字面值的映射。
 *
 * 形状：`export const X_CHANNEL = { a: "ns:a", b: "ns:b" } as const;`
 *
 * @param text 源码
 * @returns 键 → 值
 */
function channelConsts(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of text.matchAll(/export const ([A-Z0-9_]*CHANNEL[A-Z0-9_]*) = \{([\s\S]*?)\} as const;/g)) {
    const body = m[2] ?? "";
    for (const kv of body.matchAll(/([A-Za-z0-9_]+)\s*:\s*"([^"]+)"/g)) {
      out.set(`${m[1]}.${kv[1]}`, kv[2]!);
    }
  }
  return out;
}

/** 解析一个通道表达式：字面量直接给值，`CONST.键` 查表（查不到返回 null）。 */
function resolveChannel(expr: string, consts: Map<string, string>): string | null {
  const literal = /^"([^"]+)"$/.exec(expr.trim());
  if (literal) return literal[1]!;
  const member = /^([A-Za-z0-9_$.]+)$/.exec(expr.trim());
  if (member) return consts.get(member[1]!) ?? null;
  return null;
}

describe("IPC 契约：渲染层调的通道，主进程必须有人接（P93）", () => {
  it("⭐ `ipcRenderer.invoke/send` 的每个通道都有 `ipcMain.handle/on` 接它", () => {
    /* 通道常量可能声明在 electron/ 或 shared/ 下的任何文件里 */
    const consts = new Map<string, string>();
    for (const file of [...tsFiles(path.join(ROOT, "electron")), ...tsFiles(path.join(ROOT, "shared"))]) {
      for (const [k, v] of channelConsts(readFileSync(file, "utf8"))) consts.set(k, v);
    }

    const preloadText = readFileSync(PRELOAD, "utf8");
    const invoked = new Map<string, string>(); // 通道值 → 出现处
    for (const m of preloadText.matchAll(/ipcRenderer\.(?:invoke|send)\(([^,)]+)/g)) {
      const value = resolveChannel(m[1]!, consts);
      if (!value) continue; // 解析不出字面值（动态拼的）—— 这条守卫管不了，交给类型
      const line = preloadText.slice(0, m.index).split("\n").length;
      invoked.set(value, `electron/preload.ts:${line}`);
    }

    const handled = new Set<string>();
    for (const file of tsFiles(path.join(ROOT, "electron"))) {
      const text = readFileSync(file, "utf8");
      /*
       * ⚠️ 接收者**不止** `ipcMain`：这个仓里有几处是**注入式**注册的
       * （`registerWindowIpc(ipcMainInstance, …)` 这类，为了能在测试里塞假的 ipcMain），
       * 名字是 `ipcMainInstance` / `ipc`。只认 `ipcMain.handle` 的话，这些模块
       * 全会被误判成"没人接"（第一版就是这样，一口气报了 14 个假缺失）。
       */
      for (const m of text.matchAll(/\b(?:ipcMain|ipcMainInstance|ipc)\s*\.\s*(?:handle|on)\(([^,)]+)/g)) {
        const value = resolveChannel(m[1]!, consts);
        if (value) handled.add(value);
        else {
          /* 动态通道（如 `prefix + name`）—— 收前缀，按前缀放行 */
          const dyn = /^[`"']([^`"']+)/.exec(m[1]!.trim());
          if (dyn) handled.add(`${dyn[1]!}*`);
        }
      }
    }

    const missing: string[] = [];
    for (const [channel, where] of invoked) {
      if (handled.has(channel)) continue;
      if ([...handled].some((h) => h.endsWith("*") && channel.startsWith(h.slice(0, -1)))) continue;
      missing.push(`${channel}（渲染层在 ${where} 调它）`);
    }
    expect(
      missing,
      ["这些通道渲染层会调，但主进程里没有 ipcMain.handle/on —— 点了没反应，而且是整块功能：", ...missing].join("\n"),
    ).toEqual([]);
  });

  it("⭐ 契约与桥仍然钉着（`satisfies ShellBridge` 那条语句还在）", () => {
    const preload = readFileSync(PRELOAD, "utf8");
    expect(preload, "preload 末尾那句 satisfies ShellBridge 不见了 —— 契约与桥就没有任何东西钉着了").toContain(
      "satisfies ShellBridge",
    );
  });

  it("契约不许再手抄形状（P93 的三处都是这么漂的）", () => {
    const ipc = readFileSync(path.join(ROOT, "shared", "ipc.ts"), "utf8");
    /* drive.list 要用 DriveEntry；agents 要用 AgentFile；readings/docs 要用真实类型 */
    expect(ipc, "drive.list 又手抄形状了（用 DriveEntry）").toContain("list: () => Promise<DriveEntry[]>");
    expect(ipc, "agents 又写成 unknown 了（用 AgentFile）").toContain("load: () => Promise<AgentFile>");
    expect(ipc, "readings 又写成 unknown 了（用 Reading[]）").toContain("load: () => Promise<Reading[]>");
    expect(ipc, "docs 又写成 unknown 了（用 Doc[]）").toContain("load: () => Promise<Doc[]>");

    /*
     * 渲染层这边：DocPanel 不许再手抄 drive 条目的形状。
     * ⚠️ 要看**去掉注释**的源码 —— 改动说明里会引用旧写法，raw 读会自己撞自己。
     */
    const docPanelRaw = readFileSync(path.join(ROOT, "src", "workbench", "DocPanel.tsx"), "utf8");
    const docPanel = docPanelRaw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    expect(docPanel, "DocPanel 又手抄 drive 条目形状了").not.toContain("Array<{ name: string; origin: string }>");
    expect(docPanel, "DocPanel 要用 ShellBridge + DriveEntry").toContain("Pick<DriveEntry,");
  });
});
