import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

/**
 * base 必须是 './'：Electron 生产模式用 file:// 加载 dist/index.html，
 * 绝对路径 /assets/... 会解析到磁盘根目录而白屏。
 */
export default defineConfig({
  base: "./",
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
      "@shared": path.resolve(__dirname, "shared"),
    },
  },
  optimizeDeps: {
    /**
     * 预打包重型依赖。
     *
     * markmap / mermaid 是节点渲染器里**动态 import** 的。如果等到运行时才第一次
     * 请求，Vite 会边跑边重新预构建，期间已发出的请求会拿到
     * `504 Outdated Optimize Dep` —— 表现就是导图/图表节点白屏、控制台报错。
     * 在这里显式列出来，dev server 启动时就一次构建好。
     */
    include: ["react", "react-dom", "zustand", "@xyflow/react", "prismjs", "dompurify", "pangu", "mermaid", "markmap-lib", "markmap-view"],
  },
  server: {
    port: 5173,
    strictPort: true,
    watch: {
      /**
       * 忽略规则（都是实测踩过的坑）：
       *   · 编辑器落盘的临时目录 —— chokidar 会抛 EBUSY 并**直接干掉 dev server**
       *     （`.selection.ts.<pid>.<uuid>.tmpdir`）
       *   · `data/` —— Electron 的数据目录（GPU 缓存等）里面是活跃文件，
       *     被监听同样会 EBUSY 崩掉 dev server
       */
      ignored: ["**/.*.tmpdir/**", "**/*.tmp", "**/node_modules/**", "**/dist/**", "**/data/**"],
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: false,
    // mermaid / markmap 是动态 chunk，体积本来就大，单独放宽阈值
    chunkSizeWarningLimit: 3000,
  },
});
