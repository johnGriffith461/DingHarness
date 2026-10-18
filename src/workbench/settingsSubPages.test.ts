import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * 守卫：**设置子页不许互相串内容**（2026-10-16，审计 P260）。
 *
 * 修前实测：子页分支写成 `page === "profile" ? 资料块 : 账号块` —— 于是**任何**不是资料的页
 * （通用、关于）都会在底下再挂一整块账号内容：同一个 `.wb-setpage-body` 渲染两遍，
 * 通用页在「设置分类 / 记忆 / 默认模型 / 新话题」之后追加「当前状态 / 可用的能力 / 依赖账号的功能」。
 *
 * 判据（源码级 —— 这一层没有渲染环境，与仓库里其它组件守卫同一手法）：
 *   ① **不许用三元式的 else 兜底**渲染某个子页（那正是这条 bug 的形状）；
 *   ② 每个子页由 `page === "<页名>"` 精确匹配渲染，页名取自 `SettingsSubPage` 的联合类型；
 *   ③ 账号块要有自己的 testid（验收与排错都要能定位它）。
 */

const ROOT = path.resolve(__dirname, "..", "..");
const PAGES = path.join(ROOT, "src", "workbench", "SettingsPages.tsx");

describe("设置子页的分支（P260）", () => {
  const raw = readFileSync(PAGES, "utf8");
  const src = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  it("⭐ 不许再用「不是 A 就是 B」的 else 兜底渲染子页", () => {
    /* 形状：`page === "..." ? (` … `) : (` —— 后面这个 else 分支就是串内容的入口 */
    const suspicious = [...src.matchAll(/page === "[a-z]+" \?[\s\S]{0,2000}?\) : \(/g)].map((m) => m[0].slice(0, 60));
    expect(
      suspicious,
      [
        "这些地方用 else 兜底渲染子页 —— 任何别的页都会跟着渲染它（P260 就是这么来的）：",
        ...suspicious,
        "改成逐个 `page === \"<页名>\" ? (…) : null`（只渲染匹配的那一页）。",
      ].join("\n"),
    ).toEqual([]);
  });

  it("⭐ 每个子页都是精确匹配渲染的，且账号块有 testid", () => {
    const ids = [...src.matchAll(/page === "([a-z]+)" \?/g)].map((m) => m[1]);
    for (const page of ["profile", "account", "general", "about"]) {
      expect(ids, `子页「${page}」没有精确匹配的渲染分支`).toContain(page);
    }
    expect(src, "账号块要有 testid（验收与排错都要能定位它）").toContain('data-testid="wb-setpage-account-body"');
  });

  it("页名与 `SettingsSubPage` 的联合类型对得上（写错一个字母就是整页空白）", () => {
    const declared = /export type SettingsSubPage = ([^;]+);/.exec(src);
    expect(declared, "找不到 SettingsSubPage 的声明").not.toBeNull();
    const names = [...declared![1]!.matchAll(/"([a-z]+)"/g)].map((m) => m[1]);
    const rendered = new Set([...src.matchAll(/page === "([a-z]+)" \?/g)].map((m) => m[1]));
    for (const name of names) {
      /*
       * 这几页由**独立组件**渲染（整页搬进来，用 `if (page === "…") {` 而不是三元），
       * 所以不进上面那个正则的名单：
       *   · models / plugins：设置里跳走的两个子页；
       *   · team（V5-3 的产品面，V5 收尾加）：`TeamPage` 一整块。
       * ⚠️ 放行的前提是"它真被渲染"（上面那条 `ids` 断言仍要求 profile/account/general/about
       * 用精确匹配，而 types 里多出来的名字必须在这里说清为什么）。
       */
      if (["models", "plugins", "team", "knowledge"].includes(name)) continue;
      expect(rendered.has(name), `类型里声明了「${name}」这一页，但这里没有渲染分支`).toBe(true);
    }
  });
});
