import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * **文档站与样例的真话守卫**（L10）。
 *
 * 挡三类"文档看起来有、其实不能用"：
 * ① 导航/页面表里点了名，源文件却不在（生成时被静默跳过 → 站里少一页）；
 * ② 教程里教了一条 `ding <命令>`，CLI 根本不认（用户照做就报"不认识的子命令"）；
 * ③ npm 安装命令写的包名与 `package.json` 不是同一个（照抄装不上）。
 *
 * 渲染器的死链检查在 `scripts/build-docs-site.mjs` 里（生成后逐个 href 验）。
 */

const ROOT = path.resolve(__dirname, "..");
const read = (rel: string): string => readFileSync(path.join(ROOT, rel), "utf8");

/** CLI 真实命令名单（从 `help.ts` 的 `KNOWN_COMMANDS` 解析，与派发同源）。 */
function knownCommands(): Set<string> {
  const src = read("hosts/cli/help.ts");
  const block = /export const KNOWN_COMMANDS[^=]*=\s*new Set\(\[([\s\S]*?)\]\)/.exec(src)?.[1] ?? "";
  return new Set([...block.matchAll(/"([a-z][a-z0-9-]*)"/g)].map((m) => m[1]!));
}

describe("L10：文档站页面表与源文件", () => {
  const builder = read("scripts/build-docs-site.mjs");

  it("L10 新增的三篇（教程/示例/演示脚本）都在页面表里，且源文件存在", () => {
    for (const [out, source] of [
      ["tutorial.html", "docs-site/zh/tutorial.md"],
      ["examples.html", "docs-site/zh/examples.md"],
      ["video-script.html", "docs-site/zh/video-script.md"],
      ["en/tutorial.html", "docs-site/en/tutorial.md"],
    ]) {
      expect(builder, `页面表里没有 ${out}`).toContain(`"${out}"`);
      expect(builder, `页面表里没有源 ${source}`).toContain(source);
      expect(existsSync(path.join(ROOT, source)), `源文件不存在：${source}`).toBe(true);
    }
  });

  it("导航里有教程入口（不然只能从地址栏进）", () => {
    expect(builder).toContain('["tutorial.html", "教程：跑通第一件事"]');
    expect(builder).toContain('["en/tutorial.html", "Tutorial"]');
  });
});

describe("L10：教程里教的命令都真的存在", () => {
  const known = knownCommands();
  const pages = ["docs-site/zh/tutorial.md", "docs-site/zh/examples.md", "docs-site/zh/video-script.md"];

  it("`ding <命令>` 全部在 KNOWN_COMMANDS 里", () => {
    const unknown: string[] = [];
    for (const page of pages) {
      for (const m of read(page).matchAll(/\bding ([a-z][a-z0-9-]*)/g)) {
        const cmd = m[1]!;
        if (!known.has(cmd)) unknown.push(`${page}: ding ${cmd}`);
      }
    }
    expect([...new Set(unknown)], "文档教了 CLI 不认识的命令（用户照做会报错）").toEqual([]);
  });

  it("npm 安装写的是 package.json 里那个包名", () => {
    const name = (JSON.parse(read("package.json")) as { name: string }).name;
    const gettingStarted = read("docs-site/zh/getting-started.md");
    const installs = [...gettingStarted.matchAll(/npm i -g ([\w@/-]+)/g)].map((m) => m[1]);
    expect(installs.length, "安装命令一条都没有？").toBeGreaterThan(0);
    expect(new Set(installs), `安装命令里的包名与 package.json（${name}）不一致`).toEqual(new Set([name]));
  });

  it("示例任务指名的是仓内真有的 bench 任务", () => {
    const suite = JSON.parse(read("bench/suites/harness.json")) as { tasks?: Array<{ id: string }> | string[] };
    /* 套件里写的是相对路径（`../tasks/fix-failing-test`）——任务 id 是目录名 */
    const ids = new Set(
      (Array.isArray(suite.tasks) ? suite.tasks : []).map((t) => {
        const raw = typeof t === "string" ? t : t.id;
        return raw.split("/").filter(Boolean).pop() ?? raw;
      }),
    );
    const named = [...read("docs-site/zh/examples.md").matchAll(/--task ([a-z0-9-]+)/g)].map((m) => m[1]!);
    expect(named.length).toBeGreaterThan(0);
    for (const id of named) expect(ids.has(id), `examples.md 点了 bench 里没有的任务：${id}`).toBe(true);
  });
});
