import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * 应用文档的 CSP（**审计 P06**）。
 *
 * ## 为什么这条守卫有必要
 *
 * 整改前 `index.html` **一条 CSP 都没有**（只有 charset/viewport/title/icon）。
 * 全仓唯一一处 CSP 在 `src/canvas/htmlFrame.ts` —— 那是给画布里由用户 HTML
 * 生成的 iframe **内容**用的，**不覆盖应用自身这份文档**。于是应用文档里
 * 任何被注入的脚本、任何远程资源都能无阻加载，而这条缺陷的一个特点：
 * **删掉 CSP 不会有任何测试变红**（没有任何东西读 index.html）。
 *
 * 所以这里把「这份文档带着一条像样的 CSP」写成断言：
 *  - 有且只有一条（多来源的 CSP 是"取交集"，写两条会让人以为放宽了）；
 *  - 关掉了外部代码与插件对象（`object-src 'none'`，script-src 里没有 http/https）；
 *  - 没有 `'unsafe-eval'`（这条一旦写进去等于把 CSP 的意义削掉一半）；
 *  - 同时**没有收得过紧**到会打死产品：`dshasset:`（生成图/云盘文件自己的协议）
 *    与 `data:`（base64 图）必须在 img-src 里，`ws:` 必须在 connect-src 里
 *    （Vite 开发态 HMR）—— 否则表现为"打包后图全裂/开发态热更失灵"，
 *    那种回归比没有 CSP 更让人困惑。
 *
 * ⚠️ 主进程那半边（`will-navigate` / `openExternal` 协议白名单 / `frame-ancestors`
 * 响应头 / `sandbox: false`）不在这个文件里，归 `electron/main.ts`，另一条工单。
 */

const HTML = readFileSync(path.resolve(__dirname, "../index.html"), "utf8");

/** 取出全部 CSP meta 的 content 值。 */
function cspContents(): string[] {
  /*
   * ⚠️ content 用**双引号**括起（值里满是单引号 `'self'`）——
   * 所以这里按双引号取，别写成 `[^"']*`（那会在第一个 `'` 处断掉，把断言骗过去）。
   */
  return [...HTML.matchAll(/http-equiv=["']Content-Security-Policy["']\s+content="([^"]*)"/gi)].map((m) => m[1]!);
}

describe("index.html 的 CSP", () => {
  it("恰好一条 CSP（写两条 = 取交集，会让人以为放宽了）", () => {
    expect(cspContents()).toHaveLength(1);
  });

  it("关掉了外部代码与插件对象", () => {
    const csp = cspContents()[0]!;
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("object-src 'none'");
    // script-src 里不许出现 http/https —— 远程脚本正是这条 CSP 要挡的
    const scriptSrc = /script-src([^;]*)/.exec(csp)?.[1] ?? "";
    expect(scriptSrc).not.toMatch(/https?:/);
    expect(scriptSrc).not.toContain("'unsafe-eval'");
  });

  it("没有收得过紧到打死产品：生成图协议、base64 图、开发态 HMR 都放行", () => {
    const csp = cspContents()[0]!;
    const imgSrc = /img-src([^;]*)/.exec(csp)?.[1] ?? "";
    expect(imgSrc).toContain("dshasset:");
    expect(imgSrc).toContain("data:");
    expect(/connect-src([^;]*)/.exec(csp)?.[1] ?? "").toContain("ws:");
  });

  it("base-uri / form-action 也收掉了（meta 里能生效的那两条）", () => {
    const csp = cspContents()[0]!;
    expect(csp).toContain("base-uri 'none'");
    expect(csp).toContain("form-action 'none'");
  });
});
