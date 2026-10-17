import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { installFromDir, pluginPaths, readLedger, setEnabled } from "./pluginStore";
import { loadEnabledPlugins, resetPlugins } from "../runtime/pluginHost";

/**
 * **安装/装载时的依赖门**（L04）。
 *
 * 三条判据：
 * ① 依赖没装 → 拒装（错误里说清缺谁、怎么装）；
 * ② `--allow-missing-deps` → 能装，但装载时**不装载**并报原因；
 * ③ 依赖关着 → 与没装同样不算满足。
 */

const dirs: string[] = [];
afterEach(() => {
  resetPlugins();
  for (const dir of dirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    } catch {
      /* 尽力而为（Windows） */
    }
  }
});

const tmpDir = (prefix: string): string => {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(dir);
  return dir;
};

function makePlugin(root: string, name: string, extra: Record<string, unknown> = {}): string {
  const dir = path.join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, "ding-plugin.json"),
    JSON.stringify(
      {
        name,
        version: "1.0.0",
        description: `${name} 的示例插件`,
        permissions: [],
        engines: { ding: ">=0.5.0" },
        ...extra,
      },
      null,
      2,
    ),
    "utf8",
  );
  writeFileSync(path.join(dir, "index.mjs"), "export const tools = {};\n", "utf8");
  return dir;
}

describe("安装时的依赖门", () => {
  it("缺依赖 → 拒装，错误里带装法与放行旗标", () => {
    const data = tmpDir("dh-deps-data-");
    const src = tmpDir("dh-deps-src-");
    const plugin = makePlugin(src, "needs-other", { dependencies: { "word-count": "^1.0.0" } });
    const got = installFromDir({ paths: pluginPaths(data), from: plugin });
    expect(got.ok).toBe(false);
    if (!got.ok) {
      expect(got.errors[0]).toContain("缺依赖「word-count」");
      expect(got.errors.join("\n")).toContain("--allow-missing-deps");
    }
    expect(readLedger(pluginPaths(data)).ledger.installed).toHaveLength(0);
  });

  it("先装依赖 → 再装依赖它的插件就通过", () => {
    const data = tmpDir("dh-deps-data-");
    const src = tmpDir("dh-deps-src-");
    const dep = makePlugin(src, "word-count");
    const plugin = makePlugin(src, "needs-other", { dependencies: { "word-count": "^1.0.0" } });
    const paths = pluginPaths(data);
    expect(installFromDir({ paths, from: dep }).ok).toBe(true);
    expect(installFromDir({ paths, from: plugin }).ok).toBe(true);
    expect(readLedger(paths).ledger.installed.map((p) => p.name).sort()).toEqual(["needs-other", "word-count"]);
  });

  it("依赖关着 → 不算满足", () => {
    const data = tmpDir("dh-deps-data-");
    const src = tmpDir("dh-deps-src-");
    const dep = makePlugin(src, "word-count");
    const plugin = makePlugin(src, "needs-other", { dependencies: { "word-count": "^1.0.0" } });
    const paths = pluginPaths(data);
    expect(installFromDir({ paths, from: dep }).ok).toBe(true);
    setEnabled(paths, "word-count", false);
    const got = installFromDir({ paths, from: plugin });
    expect(got.ok).toBe(false);
    if (!got.ok) expect(got.errors[0]).toContain("装了但关着");
  });

  it("--allow-missing-deps 能装，但装载时跳过并报原因", async () => {
    const data = tmpDir("dh-deps-data-");
    const src = tmpDir("dh-deps-src-");
    const plugin = makePlugin(src, "needs-other", { dependencies: { "word-count": "^1.0.0" } });
    const paths = pluginPaths(data);
    const got = installFromDir({ paths, from: plugin, allowMissingDeps: true });
    expect(got.ok).toBe(true);

    const loaded = await loadEnabledPlugins(readLedger(paths).ledger.installed);
    expect(loaded).toHaveLength(1);
    expect(loaded[0]?.entries).toEqual([]);
    expect(loaded[0]?.problems.join("\n")).toContain("依赖未满足");
    expect(loaded[0]?.problems.join("\n")).toContain("word-count");
  });

  it("依赖版本不符 → 拒装（范围用的是 engines 同一套语法）", () => {
    const data = tmpDir("dh-deps-data-");
    const src = tmpDir("dh-deps-src-");
    const dep = makePlugin(src, "word-count");
    const plugin = makePlugin(src, "needs-other", { dependencies: { "word-count": "^2.0.0" } });
    const paths = pluginPaths(data);
    expect(installFromDir({ paths, from: dep }).ok).toBe(true);
    const got = installFromDir({ paths, from: plugin });
    expect(got.ok).toBe(false);
    if (!got.ok) expect(got.errors[0]).toContain("版本不符");
  });
});
