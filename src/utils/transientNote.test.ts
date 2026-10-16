import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * 守卫：**会自己消失的提示条不许互相踩踏**（2026-10-16，审计 P91）。
 *
 * 修前实测的写法是裸发定时器：
 *
 * ```ts
 * setMaterialNote("加了 3 个文件");
 * window.setTimeout(() => setMaterialNote(""), 4000);
 * ```
 *
 * 三个毛病一起：① 4 秒内又操作一次（提示换成了新话），前一个定时器到点把**新话**擦掉
 * （用户看到提示一闪而过，以为没生效）；② 卸载后回调照样跑；③ 句柄没人存，想清也清不了。
 * 仓里这种写法有七处（Composer / PluginsPage / ReaderPanel）。
 *
 * 判据两半（这一层没有渲染环境，组件那半用源码守卫，与仓库里其它组件守卫同一手法）：
 *   · **行为**：`useTransientNote` 的定时机理 —— 后一条提示必须活够自己的时间；
 *   · **源码**：全仓不许再出现"裸发 setTimeout 去清一条提示"的写法。
 */

const ROOT = path.resolve(__dirname, "..", "..");

/** 全仓 .tsx 源码（去注释）。 */
function allTsx(dir = path.join(ROOT, "src"), out: Array<{ file: string; text: string }> = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) allTsx(full, out);
    else if (/\.tsx$/.test(entry.name) && !/\.test\.tsx$/.test(entry.name)) {
      const text = readFileSync(full, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
      out.push({ file: path.relative(ROOT, full).split(path.sep).join("/"), text });
    }
  }
  return out;
}

describe("会自己消失的提示条（P91）", () => {
  it("⭐ 全仓：不许再裸发 setTimeout 去清提示（句柄要有人管）", () => {
    const offenders: string[] = [];
    /* 形状：`setTimeout(() => setXxxNote("")…` / `setTimeout(() => setSaved(false)…` */
    const pattern = /setTimeout\(\s*\(\)\s*=>\s*set[A-Za-z]*\(\s*(""|false)\s*\)/g;
    for (const { file, text } of allTsx()) {
      for (const m of text.matchAll(pattern)) {
        const line = text.slice(0, m.index).split("\n").length;
        offenders.push(`${file}:${line} → ${m[0].slice(0, 48)}`);
      }
    }
    expect(
      offenders,
      [
        "这些地方裸发定时器清提示 —— 4 秒内再操作一次，前一个定时器会把**新**提示提前擦掉，且卸载后照样跑：",
        ...offenders,
        "改用 src/workbench/transientNote.ts 的 useTransientNote / useTransientFlag（句柄与卸载都由它管）。",
      ].join("\n"),
    ).toEqual([]);
  });

  it("⭐ 三处老现场改到了共用件上（Composer / PluginsPage / ReaderPanel）", () => {
    const files: Array<[string, string]> = [
      ["src/workbench/Composer.tsx", "useTransientNote(4000)"],
      ["src/workbench/PluginsPage.tsx", "useTransientNote(3000)"],
      ["src/workbench/ReaderPanel.tsx", "useTransientFlag(1500)"],
    ];
    for (const [rel, needle] of files) {
      const text = readFileSync(path.join(ROOT, rel), "utf8");
      expect(text, `${rel} 没走共用件（${needle}）`).toContain(needle);
      expect(text, `${rel} 里还留着 setMaterialNote/setPluginNote/setSaved 之类自己管的 setter`).not.toMatch(
        /set(MaterialNote|PluginNote|McpNote)\("/,
      );
    }
  });
});
