import { defineConfig } from "vitest/config";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

/**
 * `@xyflow/react` 把 `@xyflow/system` 当作自己的依赖，pnpm 的隔离式 node_modules 不会把它
 * 提升到根目录，因此测试环境里直接 `import "@xyflow/system"` 解析不到。
 * 这里从 `@xyflow/react` 自己的位置解析出那份包，再指向它的 ESM 入口
 * （Node 在 `node` 条件下会挑到 UMD，命名导出拿不到，会报 "object is not iterable"）。
 *
 * 走同一份实现是为了让单测测的换算与画布真实使用的换算完全一致，而不是抄一份公式。
 */
function resolveXyflowSystem(): string {
  try {
    const require = createRequire(import.meta.url);
    const fromReact = createRequire(require.resolve("@xyflow/react/package.json"));
    const systemMain = fromReact.resolve("@xyflow/system");
    const esm = resolve(dirname(systemMain), "..", "esm", "index.mjs");
    return existsSync(esm) ? esm : systemMain;
  } catch {
    return "@xyflow/system";
  }
}

/** 单测跑 node 环境：被测对象是纯换算函数，不需要 DOM。 */
export default defineConfig({
  resolve: {
    alias: {
      "@": resolve(here, "src"),
      "@shared": resolve(here, "shared"),
      "@engine": resolve(here, "engine"),
      "@xyflow/system": resolveXyflowSystem(),
    },
  },
  test: {
    environment: "node",
    /*
     * `engine/**` 也在里面：内核是**纯逻辑**（不 import electron），
     * 所以它能与渲染层一起在同一个 node 环境里被直接断言 —— 那是"可整包单测"
     * 这条不变量在工程上的落点（内核测试不需要起应用）。
     */
    include: ["src/**/*.test.ts", "engine/**/*.test.ts"],
  },
});
