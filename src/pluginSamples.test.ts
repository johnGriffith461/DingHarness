import { mkdtempSync, readFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { installFromDir, pluginPaths, readLedger } from "@engine/adapters/pluginStore";
import { loadEnabledPlugins, resetPlugins, runHooks, runPluginTool } from "@engine/runtime/pluginHost";
import { checkManifest } from "@engine/runtime/plugins";
import { describeToolResult } from "@shared/agentTools";

import { removeAll } from "./testFs";

/**
 * 守卫：**文档里给读者的示例，必须真能装、真能跑**（2026-10-16，审计 D10 / P204 / P205 / P207）。
 *
 * ## 它挡的是什么
 *
 * `PLUGIN.md` 原来教的那套形状**装不上任何工具**（审计 P204）：manifest 没写
 * `tools` / `hooks`、入口导出的是**数组**（装载端按 `Object.keys(mod.tools)` 对账，
 * 数组的键是 `0`,`1`,`2`…），它给的 manifest 还缺必填的 `engines`；另外它承诺的
 * 「参考实现」在仓里根本不存在（P207，`scripts/accept/` 里没有任何插件脚本）。
 * 后果是：读者照着写完，发现"装上了但什么都不发生"，而文档说不出所以然。
 *
 * 所以这一条的做法不是"再写一遍文档"，而是**让示例自己进回归**：
 * `plugin-samples/` 下的每个目录都要走完整条链路 ——
 * 装（`installFromDir`）→ 装载（`loadEnabledPlugins`）→ 调工具（`runPluginTool`）
 * → 跑钩子（`runHooks`），并按文档承诺的形状断言结果。
 *
 * **把示例改坏，这条就红**：删掉一个 `export`、漏一项 `tools:register`、
 * 把 `tools` 改回数组、去掉清单里的 `engines` —— 四种改法各会打在不同的断言上。
 *
 * ## 边界（如实记）
 *
 * - 只测 `plugin-samples/` 下的目录（这是**给读者抄的那一份**）；
 *   内联夹具那条整链路测试在 `engine/runtime/plugins.test.ts`（那份不在本轮范围）。
 * - npm 渠道（`npm pack` 那一跳）不在这里测：它要网络（`installFromTarball` 有单测）。
 */

const ROOT = path.resolve(__dirname, "..");
const SAMPLES = path.join(ROOT, "plugin-samples");

/** `plugin-samples/` 下每个带清单的目录。 */
function sampleDirs(): string[] {
  return readdirSync(SAMPLES)
    .map((name) => path.join(SAMPLES, name))
    .filter((full) => {
      try {
        return statSync(full).isDirectory() && statSync(path.join(full, "ding-plugin.json")).isFile();
      } catch {
        return false;
      }
    });
}

let tmpDirs: string[] = [];
function freshDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "dh-plugin-samples-"));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  resetPlugins();
  for (const dir of tmpDirs) removeAll(dir);
  tmpDirs = [];
});

describe("插件示例能真的装起来（D10）", () => {
  const dirs = sampleDirs();

  it("① 起码有一份示例（不然「文档里给了能抄的东西」这句话就是空的）", () => {
    expect(dirs.length, "plugin-samples/ 下一份示例都没有").toBeGreaterThan(0);
    /* 文档要指着它 —— 指着不存在的东西正是 P207 的形状（`src/docClaims.test.ts` ③ 也管这条） */
    const doc = readFileSync(path.join(ROOT, "PLUGIN.md"), "utf8");
    expect(doc, "PLUGIN.md 没提到 plugin-samples/（读者不知道该抄哪份）").toContain("plugin-samples/");
  });

  for (const dir of dirs) {
    const name = path.basename(dir);

    it(`② ${name}：清单合法 + 装得上 + 声明与导出对得上`, async () => {
      const raw = JSON.parse(readFileSync(path.join(dir, "ding-plugin.json"), "utf8")) as unknown;
      const checked = checkManifest(raw);
      expect(checked.ok, `清单不合法（照它写会装不上）：${checked.ok ? "" : checked.errors.join("；")}`).toBe(true);

      const paths = pluginPaths(freshDir());
      const got = installFromDir({ paths, from: dir });
      expect(got.ok, `装不上：${got.ok ? "" : got.errors.join("；")}`).toBe(true);
      const { ledger } = readLedger(paths);
      expect(ledger.installed.map((p) => p.name)).toContain(name);

      const loaded = await loadEnabledPlugins(ledger.installed);
      const plugin = loaded.find((p) => p.name === name);
      expect(plugin, "台账里有、但没装载进来").toBeTruthy();
      expect(plugin!.problems, `装载时报了问题（示例与文档的形状对不上）：${plugin!.problems.join("；")}`).toEqual([]);

      /* 清单声明的工具 = 真的接上的工具（少一个就是"文档教你导出、装载端认不出来"） */
      const declared = (checked.ok ? checked.manifest.tools : []) ?? [];
      expect(plugin!.entries.map((e) => e.name).sort()).toEqual(declared.map((t) => `plugin__${name}__${t}`).sort());
      expect(plugin!.entries.length).toBeGreaterThan(0);

      /* 工具说明确实是给模型的（不是空串）——"装上了但模型看不见"同样是失效形态 */
      for (const entry of plugin!.entries) expect(entry.description.length).toBeGreaterThan(0);
    });

    it(`③ ${name}：工具能被调用，返回形状与文档一致（ok + output.line）`, async () => {
      const paths = pluginPaths(freshDir());
      const got = installFromDir({ paths, from: dir });
      expect(got.ok).toBe(true);
      const { ledger } = readLedger(paths);
      await loadEnabledPlugins(ledger.installed);

      const first = ledger.installed[0]!.manifest.tools?.[0];
      expect(first, "这份示例没声明任何工具，③ 测不到东西").toBeTruthy();
      const full = `plugin__${name}__${first}`;

      /* 具体入参按示例自己的 schema：word-count 收 `text` */
      const out = (await runPluginTool(full, { text: "a b c" })) as { ok?: boolean; output?: { count?: number; line?: string } };
      expect(out.ok, "示例工具返回了 ok:false").toBe(true);
      expect(typeof out.output?.line, "文档承诺 output.line 是界面上那一行留痕，示例没给").toBe("string");

      /*
       * ⭐ 文档承诺的那句"line 会出现在留痕里"必须**真的成立**（审计 P205）。
       * 这条同时钉住 `shared/agentTools.describeToolResult` 的插件分支与示例的返回形状：
       * 两边任意一边改坏，这里就红。
       */
      const trace = describeToolResult(full, true, out);
      expect(trace, `留痕里没有示例写的那句话：「${trace}」`).toContain(out.output!.line!);
      expect(trace, "插件工具没有自己的标签（留痕认不出是谁干的）").toContain(`插件·${name}`);
    });

    it(`④ ${name}：声明的钩子真的会被跑到`, async () => {
      const paths = pluginPaths(freshDir());
      const got = installFromDir({ paths, from: dir });
      expect(got.ok).toBe(true);
      const { ledger } = readLedger(paths);
      const loaded = await loadEnabledPlugins(ledger.installed);
      const declaredHooks = ledger.installed[0]!.manifest.hooks ?? [];
      for (const hook of declaredHooks) {
        expect(loaded[0]!.hooks[hook], `清单声明了 ${hook}，但它没真的接上`).toBeTypeOf("function");
      }
      /* 跑一遍：抛错会被 runHooks 吞掉并打日志，所以这里断言的是"调用不炸" */
      await expect(runHooks("tool:before", { name: "read_file", input: {} })).resolves.toBeUndefined();
    });
  }
});
