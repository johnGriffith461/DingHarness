import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import { APP_CHANNEL } from "../electron/ipc/appChannel";
import { looksLikeViteDevServer, probeViteDevServer, VITE_DEV_MARK } from "../electron/ipc/devServerProbe";
import { isAllowedExternalUrl, isAllowedNavigation, withFrameAncestors } from "../electron/ipc/navigationGuard";
import { safeRegister } from "../electron/ipc/registerGuard";
import { ensureSingleInstance } from "../electron/ipc/singleInstance";
import { clampToWorkArea } from "../electron/ipc/windowBounds";

/**
 * 主进程加固与收口的回归用例（**审计 P06 / P12 / P39 / P45 / P63 / P66**）。
 *
 * 这几条都是"主进程里少了一句话，功能照常、缺陷留着"的形状 —— 纯逻辑抽进
 * `electron/ipc/*.ts` 的可测函数（无 electron 依赖）+ 源码级守卫（挡"写法被改回去"）。
 * 另一半（报文收口、窗口控制）在 `src/ipcStoreSafety.test.ts`。
 */

const ROOT = path.resolve(__dirname, "..");

/** 读源码并去注释 —— 否则我自己写在注释里的解释会被当成违规（`windowChrome.test.ts` 同一个套路）。 */
function code(rel: string): string {
  const raw = readFileSync(path.join(ROOT, rel), "utf8");
  return raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

/** 读源码（保留注释：要查"理由有没有写在注释里"时用）。 */
function raw(rel: string): string {
  return readFileSync(path.join(ROOT, rel), "utf8");
}

describe("P06 · 外链协议白名单", () => {
  it("只放 http / https / mailto", () => {
    expect(isAllowedExternalUrl("https://example.com/a")).toBe(true);
    expect(isAllowedExternalUrl("http://127.0.0.1:5173")).toBe(true);
    expect(isAllowedExternalUrl("mailto:me@example.com")).toBe(true);
    expect(isAllowedExternalUrl("HTTPS://EXAMPLE.COM")).toBe(true); // 协议大小写不敏感
  });

  it("file / javascript / data / 坏串一律拒", () => {
    expect(isAllowedExternalUrl("file:///C:/Windows/System32/cmd.exe")).toBe(false);
    expect(isAllowedExternalUrl("javascript:alert(1)")).toBe(false);
    expect(isAllowedExternalUrl("data:text/html,<script>alert(1)</script>")).toBe(false);
    expect(isAllowedExternalUrl("vscode://x")).toBe(false);
    expect(isAllowedExternalUrl("根本不是 url")).toBe(false);
    expect(isAllowedExternalUrl("")).toBe(false);
    expect(isAllowedExternalUrl(undefined)).toBe(false);
    expect(isAllowedExternalUrl({ url: "https://x" })).toBe(false);
  });
});

describe("P06 · 应用内导航只放行自身文档与 dev server 同源", () => {
  const allowed = { fileUrl: "file:///C:/app/dist/index.html", devServerUrl: "http://localhost:5173" };

  it("自身产物文档放行（路径大小写/斜杠无关）", () => {
    expect(isAllowedNavigation("file:///C:/app/dist/index.html", allowed)).toBe(true);
    expect(isAllowedNavigation("file:///c:/app/dist/index.html", allowed)).toBe(true);
  });

  it("别的 file 路径、别的来源、javascript 一律拦", () => {
    expect(isAllowedNavigation("file:///C:/Windows/win.ini", allowed)).toBe(false);
    expect(isAllowedNavigation("https://evil.example.com/", allowed)).toBe(false);
    expect(isAllowedNavigation("javascript:alert(1)", allowed)).toBe(false);
    expect(isAllowedNavigation("about:blank", allowed)).toBe(false);
  });

  it("dev server 同源（含子路径）放行，不同端口拦", () => {
    expect(isAllowedNavigation("http://localhost:5173/", allowed)).toBe(true);
    expect(isAllowedNavigation("http://localhost:5173/src/main.tsx", allowed)).toBe(true);
    expect(isAllowedNavigation("http://localhost:9999/", allowed)).toBe(false);
  });
});

describe("P06 · frame-ancestors 响应头（meta CSP 不管它）", () => {
  it("没有 CSP 头时补一条 frame-ancestors 'none'", () => {
    expect(withFrameAncestors(undefined)).toEqual({ "Content-Security-Policy": ["frame-ancestors 'none'"] });
  });

  it("已有 CSP 头时**追加**不替换（多来源是取交集，替换会静默放宽）", () => {
    const out = withFrameAncestors({ "content-security-policy": ["default-src 'self'"], "x-a": ["1"] });
    expect(out["Content-Security-Policy"]).toEqual(["default-src 'self'", "frame-ancestors 'none'"]);
    expect(out["content-security-policy"]).toBeUndefined(); // 归并到规范大小写
    expect(out["x-a"]).toEqual(["1"]);
  });

  it("幂等：重复加不会叠两条", () => {
    const once = withFrameAncestors(undefined);
    const twice = withFrameAncestors(once);
    expect(twice["Content-Security-Policy"]).toEqual(["frame-ancestors 'none'"]);
  });
});

describe("P06 · 主进程那半边真的接上了（源码守卫）", () => {
  const main = code("electron/main.ts");

  it("will-navigate 接了，且用导航白名单判 + preventDefault", () => {
    expect(main, "main.ts 没有 will-navigate —— 页面自己 location.href 就把窗口导航走了").toContain(
      'webContents.on("will-navigate"',
    );
    expect(main).toContain("isAllowedNavigation");
    expect(main, "拦下的导航没有 preventDefault，等于没拦").toContain("event.preventDefault()");
  });

  it("openExternal 走协议白名单，不再是裸的 shell.openExternal(url)", () => {
    expect(main).toContain("isAllowedExternalUrl");
    /*
     * 每一处 `shell.openExternal(` 前面都必须紧跟白名单判定 —— 回退成裸调用
     * （`void shell.openExternal(url);`，旧写法）会让这里的两个计数对不上。
     */
    const opens = main.match(/shell\.openExternal\(/g) ?? [];
    const guarded = main.match(/isAllowedExternalUrl\(url\)\)\s*void shell\.openExternal\(url\)/g) ?? [];
    expect(opens.length).toBeGreaterThanOrEqual(1);
    expect(guarded.length, "有 shell.openExternal 没有经过 isAllowedExternalUrl 判定").toBe(opens.length);
  });

  it("frame-ancestors 由 onHeadersReceived 补", () => {
    expect(main).toContain("onHeadersReceived");
    expect(main).toContain("withFrameAncestors");
  });

  it("sandbox: false 有理由（理由就是 preload 里那串相对 require）", () => {
    const text = raw("electron/main.ts");
    expect(text).toContain("sandbox: false");
    // 理由必须点到 preload（同一段注释里）
    expect(text, "sandbox: false 没有写明理由").toMatch(/sandbox: false[\s\S]{0,600}?preload/);
    // 理由成立的事实：preload 直接 import 一串本地模块（沙箱 preload 的 require 加载不了它们）
    const preload = code("electron/preload.ts");
    const localImports = preload.match(/from "\.\/ipc\/[a-zA-Z]+"/g) ?? [];
    expect(localImports.length, "preload 不再是「一串本地 require」的话，这条取舍的理由就要重写").toBeGreaterThanOrEqual(5);
  });
});

describe("P12 · dev server 探测不许把 404 当通过", () => {
  it("只有页面里带 Vite 客户端标记才算", () => {
    expect(looksLikeViteDevServer(`<html><script src="${VITE_DEV_MARK}"></script></html>`)).toBe(true);
    expect(looksLikeViteDevServer("<!doctype html><h1>404 Not Found</h1>")).toBe(false);
    expect(looksLikeViteDevServer("")).toBe(false);
  });

  it("probeViteDevServer 的四条路", async () => {
    const okWithMark = vi.fn(async () => ({ ok: true, status: 200, text: async () => `<x src="${VITE_DEV_MARK}">` }));
    expect(await probeViteDevServer("http://localhost:5173", okWithMark as unknown as typeof fetch)).toBe(true);

    const notFound = vi.fn(async () => ({ ok: false, status: 404, text: async () => "<h1>404</h1>" }));
    expect(await probeViteDevServer("http://localhost:5173", notFound as unknown as typeof fetch)).toBe(false);

    const wrongServer = vi.fn(async () => ({ ok: true, status: 200, text: async () => "<html>别的服务</html>" }));
    expect(await probeViteDevServer("http://localhost:5173", wrongServer as unknown as typeof fetch)).toBe(false);

    const boom = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });
    expect(await probeViteDevServer("http://localhost:5173", boom as unknown as typeof fetch)).toBe(false);
  });

  it("main.ts 不再按 `res.status === 404` 判通过", () => {
    const main = code("electron/main.ts");
    expect(main).toContain("probeViteDevServer");
    expect(main).not.toContain("res.status === 404");
  });
});

describe("P39 · 单实例锁", () => {
  it("抢不到锁返回 false，且**不注册** second-instance", () => {
    const on = vi.fn();
    const app = { requestSingleInstanceLock: () => false, on };
    expect(ensureSingleInstance(app, vi.fn())).toBe(false);
    expect(on).not.toHaveBeenCalled();
  });

  it("抢到锁返回 true，并让第二个实例的回调真的能亮已有窗口", () => {
    const registered: Record<string, () => void> = {};
    const app = {
      requestSingleInstanceLock: () => true,
      on: (event: string, listener: () => void) => {
        registered[event] = listener;
        return app;
      },
    };
    const cover = vi.fn();
    expect(ensureSingleInstance(app, cover)).toBe(true);
    expect(typeof registered["second-instance"]).toBe("function");
    registered["second-instance"]!();
    expect(cover).toHaveBeenCalledTimes(1);
  });

  it("main.ts 真的用了它，并且没拿到锁就退出", () => {
    const main = code("electron/main.ts");
    expect(main).toContain("ensureSingleInstance");
    expect(main).toMatch(/isPrimaryInstance[\s\S]{0,200}?app\.quit\(\)/);
  });
});

describe("P45 · 一个模块一层 try", () => {
  it("坏的那个只丢它自己，后面的照常注册", () => {
    const logged: string[] = [];
    const ran: string[] = [];
    const ok1 = safeRegister("good-a", () => ran.push("a"), (m) => logged.push(m));
    const ok2 = safeRegister(
      "broken",
      () => {
        throw new Error("端口被占");
      },
      (m) => logged.push(m),
    );
    const ok3 = safeRegister("good-b", () => ran.push("b"), (m) => logged.push(m));

    expect([ok1, ok2, ok3]).toEqual([true, false, true]);
    expect(ran).toEqual(["a", "b"]); // 大 try 会在这里只剩 ["a"]
    expect(logged).toHaveLength(1);
    expect(logged[0]).toContain("broken");
    expect(logged[0]).toContain("端口被占");
  });

  it("main.ts 里每个模块都单独一层 try（不再是一个大 try 连坐）", () => {
    const main = code("electron/main.ts");
    const calls = main.match(/safeRegister\(/g) ?? [];
    expect(calls.length, "注册点又回到共享的大 try 里了").toBeGreaterThanOrEqual(20);
    expect(main, "旧的整块 catch 标签又回来了").not.toContain("[image] 注册失败");
    expect(main).toContain("logRegisterFailure");
  });
});

describe("P63 · 窗口尺寸按屏幕可用区钳制", () => {
  const desired = { width: 1440, height: 900, minWidth: 1024, minHeight: 640 };

  it("正常屏：按期望值", () => {
    expect(clampToWorkArea({ width: 1920, height: 1080 }, desired)).toEqual(desired);
  });

  it("小屏（910×512）：窗口与最小值都不超过可用区，且 min ≤ max", () => {
    const got = clampToWorkArea({ width: 910, height: 512 }, desired);
    expect(got).toEqual({ width: 910, height: 512, minWidth: 910, minHeight: 512 });
    expect(got.minWidth).toBeLessThanOrEqual(got.width);
    expect(got.minHeight).toBeLessThanOrEqual(got.height);
  });

  it("极小的可用区也不会得到 min > max", () => {
    const got = clampToWorkArea({ width: 300, height: 200 }, desired);
    expect(got).toEqual({ width: 300, height: 200, minWidth: 300, minHeight: 200 });
  });

  it("main.ts 用 workArea 钳制，不写死四个数", () => {
    const main = code("electron/main.ts");
    expect(main).toContain("clampToWorkArea");
    expect(main).toContain("getPrimaryDisplay");
  });
});

describe("P66 · app:ping / app:userDataDir 走常量表", () => {
  it("常量值就是那两条通道", () => {
    expect(APP_CHANNEL.ping).toBe("app:ping");
    expect(APP_CHANNEL.userDataDir).toBe("app:userDataDir");
  });

  it("主进程与 preload 都不再各写一遍裸字符串", () => {
    for (const rel of ["electron/main.ts", "electron/preload.ts"]) {
      const src = code(rel);
      expect(src, `${rel} 里还有裸的 app:ping`).not.toContain('"app:ping"');
      expect(src, `${rel} 里还有裸的 app:userDataDir`).not.toContain('"app:userDataDir"');
      expect(src, `${rel} 没有从常量表取`).toContain("APP_CHANNEL");
    }
  });
});
