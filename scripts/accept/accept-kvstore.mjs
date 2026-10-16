// 配置型 store 的 SQLite KV 路径 —— **桌面端到端 + 重启**（Phase 12.1）。
//
// 为什么单开一条：批跑里那一大批验收脚本是"写 JSON 文件种数据、读 JSON 文件断言"的，
// 所以它们**固定走文件后端**（见 verify-acceptances.mjs 里那段说明）。
// 于是"默认那条路（SQLite KV）在桌面里到底行不行"需要有人盯着 —— 就是这一条。
//
// 判据（三条，都是可证伪的）：
//   ① 写进去的值**落在 KV 里**（`stores.db` 出现），且**不再写 JSON 文件**；
//   ② **重启之后**读回来还是那个值（这才是用户感知到的"设置还在"）；
//   ③ 关掉 KV（`DSH_STORE_BACKEND=file`）时它**回到写文件**（回退开关真的能退）。
import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";
import { bootApp, connectWithRetry, freshDir, killTree, pickPort, sleep, waitForPage, NO_PAGE_HINT } from "./harness.mjs";

const DATA = ".verify/kvstore-data";
const bad = [];
const note = (m) => console.log("   " + m);

/**
 * 起一次应用（数据目录固定 —— 重启要读同一个目录）。
 *
 * ⚠️ 第一、二段**显式声明 `sqlite`**：批跑给所有子进程设了 `DSH_STORE_BACKEND=file`
 * （那批脚本是读 JSON 文件断言的，见 `verify-acceptances.mjs`），
 * 而这一条要验的**正是默认那条路** —— 不覆盖回来就会被自己的批跑配置钉住（第一版就这么红的）。
 * 第三段反过来：显式用 `file` 验回退开关。
 */
async function boot(port, extraEnv = { DSH_STORE_BACKEND: "sqlite" }) {
  const booted = await bootApp({ port, dataDir: DATA, extraEnv });
  /* 用实际端口（bootApp 换过端口时它与首选不同） */
  if (!booted.ok) {
    bad.push(`应用起不来：${booted.getLog().slice(-200)}`);
    return null;
  }
  const browser = await connectWithRetry(chromium, `http://127.0.0.1:${booted.port}`, 3);
  const page = await waitForPage(browser);
  if (!page) {
    bad.push(NO_PAGE_HINT);
    await browser.close();
    return null;
  }
  return { browser, page, child: booted.child, port: booted.port };
}

/*
 * ⚠️ 形状照 `shared/memory.ts` 的 `MemoryLib`（`entries` / `enabled`）。
 * 第一版我写了 `facts` —— 于是写进 KV 的值被 `normalizeMemory` **正确地**归一成空，
 * 而我在第二段里找 `facts` 自然找不到。**红的是测试的形状，不是 KV 路径**
 * （这恰好也证明了那层归一化在干活）。
 */
const MEMORY = { entries: [{ id: "kv-1", text: "KV 路径的验收用这一条", at: Date.now() }], enabled: true };

await freshDir(DATA);
let port = await pickPort([9411]);

/* ① 第一段：经 IPC 写一条记忆（桌面 UI 走的同一条口子） */
{
  const app = await boot(port);
  if (app) {
    await sleep(1200);
    const wrote = await app.page.evaluate(async (value) => {
      const shell = globalThis.shell;
      if (!shell?.memory?.write) return "no-bridge";
      await shell.memory.write(value);
      return "ok";
    }, MEMORY);
    if (wrote !== "ok") bad.push(`经 IPC 写记忆失败：${wrote}`);
    await sleep(800);

    const files = fs.existsSync(DATA) ? fs.readdirSync(DATA) : [];
    const hasKv = files.includes("stores.db");
    const hasJson = files.includes("memory.json");
    if (!hasKv) bad.push("没看到 stores.db —— KV 那条路没被走到");
    if (hasJson) bad.push("仍然在写 memory.json —— 默认应当走 SQLite KV（不再写 JSON 文件）");
    note(`第一段：stores.db ${hasKv ? "在" : "**不在**"} / memory.json ${hasJson ? "**在**" : "不在"}`);

    await killTree(app.child);
    await app.browser.close().catch(() => undefined);
  }
}

await sleep(1500);

/* ② 第二段：**重启**，经 IPC 读回来 */
{
  port = await pickPort([port + 11, 9421]);
  const app = await boot(port);
  if (app) {
    await sleep(1500);
    const got = await app.page.evaluate(async () => {
      const shell = globalThis.shell;
      if (!shell?.memory?.read) return null;
      return shell.memory.read();
    });
    const list = got?.entries ?? [];
    const hit = Array.isArray(list) && list.some((f) => String(f?.text ?? "").includes("KV 路径的验收"));
    if (!hit) bad.push(`重启后读不到那条记忆：${JSON.stringify(got).slice(0, 160)}`);
    note(`第二段（重启后）：读到 ${list.length} 条记忆，命中=${hit}`);

    await killTree(app.child);
    await app.browser.close().catch(() => undefined);
  }
}

await sleep(1500);

/* ③ 第三段：回退开关 —— 关掉 KV 时回到写文件 */
{
  port = await pickPort([port + 11, 9431]);
  const app = await boot(port, { DSH_STORE_BACKEND: "file" });
  if (app) {
    await sleep(1200);
    await app.page.evaluate(async (value) => {
      await globalThis.shell?.memory?.write(value);
    }, { entries: [{ id: "file-1", text: "文件后端的验收用这一条", at: Date.now() }], enabled: true });
    await sleep(800);
    const hasJson = fs.existsSync(path.join(DATA, "memory.json"));
    if (!hasJson) bad.push("回退开关没生效：DSH_STORE_BACKEND=file 时应当写 memory.json");
    note(`第三段（回退开关）：memory.json ${hasJson ? "在（对）" : "**不在**"}`);

    await killTree(app.child);
    await app.browser.close().catch(() => undefined);
  }
}

await freshDir(DATA);

console.log("");
if (bad.length) {
  console.error("✗ " + bad.join("；"));
  process.exitCode = 1;
} else {
  console.log("✓ 配置型 store 的 KV 路径：写进 stores.db / 不写 JSON 文件 / 重启后读得回 / 回退开关能退");
}
