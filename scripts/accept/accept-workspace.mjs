import { chromium } from "playwright";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { NO_PAGE_HINT, bootApp, connectWithRetry, freshDir, killTree, shot, waitForPage } from "./harness.mjs";

/**
 * 验收：**agent 真的能在一个目录里干活**（2026-10-14）。
 *
 * ## 这条凭什么算"端到端"
 *
 * 它不走模型，但走的是**应用自己的工具执行路径**：渲染进程调 `ai:runTool`
 * （就是"用户点了批准"那条通道）→ 主进程 `EXECUTORS` → 落到磁盘。
 * 所以它验的是"工具真的能改这台机器上的东西"，而不是"函数返回了 ok"。
 *
 * ## 为什么要先授权工作区
 *
 * agent 能碰的目录由 `ownedDirs()` 定：应用自己的四个目录 + **用户授权的工作区**。
 * 夹具在这里把 `workspaces.json` 预置进隔离数据目录（等价于"用户点过目录选择器"）——
 * 验的是"授权**之后**能不能干活"，不是"对话框长什么样"（系统模态框没法无头点）。
 *
 * ## 十条断言
 * ① 授权之后 `list_dir` 看得到工作区里的文件
 * ② `search_files` 按内容找得到，且带**路径与行号**
 * ③ `read_file` 读得到正文
 * ④ `write_file` 新建的文件**真出现在磁盘上**
 * ⑤ `edit_file` 改的是那一处，且**只改那一处**
 * ⑥ `run_command` 真跑命令（用它写一个文件出来，再回磁盘上看）
 * ⑦ 命令的**退出码**原样带回来
 * ⑧ 越界：工作目录在授权范围外 → 拒绝（`run_command`）
 * ⑨ 界面上（输入区 ＋ 菜单）**列着这个授权**，撤销之后列表为空
 * ⑩ 撤销之后工具**立刻**碰不到那个目录了（白名单当场收紧，不用重启）
 */
const DATA = ".verify/workspace-data";
/*
 * ⚠️ 必须是**绝对**路径（2026-10-14 修）。
 *
 * 它会被当成 `run_command` 的 `workdir` **和**命令里那个输出文件的路径前缀。
 * 用相对路径时，node 会把那个"相对路径"再相对 workdir 解析一次 ——
 * 于是变成 `.verify/workspace-dir/.verify/workspace-dir/由命令写出.txt`，
 * 报 ENOENT，看着却像"跑命令没落盘"。基准目录由脚本自身位置算出来，跟着仓库走。
 */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const WORK = path.join(ROOT, ".verify", "workspace-dir");
if (!(await freshDir(DATA))) {
  console.error("✗ 数据目录 " + DATA + " 删不掉 —— 先手工关掉占着它的 Electron");
  process.exit(1);
}
/* ⚠️ 数据目录要先自己建出来：`freshDir` 只负责删干净，不负责建（原来直接写文件就 ENOENT） */
fs.mkdirSync(DATA, { recursive: true });
fs.rmSync(WORK, { recursive: true, force: true });
fs.mkdirSync(path.join(WORK, "src"), { recursive: true });
fs.writeFileSync(path.join(WORK, "README.md"), "# 工作区\n\n这里提到 星辰 项目\n", "utf8");
fs.writeFileSync(path.join(WORK, "src", "main.ts"), "const 星辰 = 1;\nexport default 星辰;\n", "utf8");

/* 预置授权（C1 信封：`{__schema, data}`）—— 等价于用户点过选择器 */
fs.writeFileSync(
  path.join(DATA, "workspaces.json"),
  JSON.stringify({ __schema: 1, data: { dirs: [WORK.replace(/\//g, "\\")] } }, null, 2),
  "utf8",
);

const PORT = 9316;
const out = {};
let child = null;
let ok = false;
let getLog = () => "";

try {
  const booted = await bootApp({ port: PORT, dataDir: DATA, timeoutMs: 30000 });
  child = booted.child;
  ok = booted.ok;
  getLog = booted.getLog;
  if (!ok) {
    console.error("[诊断] 应用输出尾部：\n" + (getLog() || "(空)").slice(-1200));
    process.exit(1);
  }

  const b = await connectWithRetry(chromium, `http://127.0.0.1:${booted.port}`);
  const page = await waitForPage(b);
  if (!page) throw new Error(NO_PAGE_HINT);
  await page.waitForSelector('[data-testid="wb"]', { timeout: 20000 });
  await page.waitForTimeout(1200);

  /**
   * 走"用户批准"那条通道真跑一个工具（不带模型）。
   *
   * ⚠️ 两层 `ok` 别搞混：`ai:runTool` 的 `ok` 是**"这次调用跑到了"**，
   * 业务结果在 `output.ok` 里。第一版读错了层，于是"越界被拒"也显示成 ok ——
   * 断言跟着一起失效（当场被 ⑧⑩ 两条逮到）。
   */
  const runTool = (name, input) =>
    page.evaluate(
      ([n, i]) =>
        globalThis.shell.ai.runTool({ name: n, input: i, toolPolicy: "全部允许" }).then((r) => ({
          ran: r?.ok,
          ok: r?.output?.ok,
          line: r?.line,
          text: r?.output?.text,
          exitCode: r?.output?.exitCode,
          error: r?.error ?? r?.output?.error,
        })),
      [name, input],
    );

  /* ── ① 看目录 ── */
  const listed = await runTool("list_dir", { path: WORK.replace(/\//g, "\\"), depth: 2 });
  out.listDir = { ok: listed.ok, line: listed.line, text: String(listed.text ?? "").slice(0, 400) };

  /* ── ② 找文件 ── */
  const found = await runTool("search_files", { pattern: "星辰", path: WORK.replace(/\//g, "\\") });
  out.search = { ok: found.ok, line: found.line, text: String(found.text ?? "").slice(0, 400) };

  /* ── ③ 读文件 ── */
  const read = await runTool("read_file", { path: path.join(WORK, "src", "main.ts").replace(/\//g, "\\") });
  out.read = { ok: read.ok, line: read.line, text: String(read.text ?? "").slice(0, 200) };

  /* ── ④ 新建文件（然后回磁盘上看） ── */
  const wrote = await runTool("write_file", {
    path: path.join(WORK, "纪要.md").replace(/\//g, "\\"),
    content: "# 纪要\n\n- 第一条\n",
  });
  out.write = { ok: wrote.ok, line: wrote.line };
  out.fileOnDisk = fs.existsSync(path.join(WORK, "纪要.md")) ? fs.readFileSync(path.join(WORK, "纪要.md"), "utf8") : "(没有这个文件)";

  /* ── ⑤ 改文件：只改那一处 ── */
  const edited = await runTool("edit_file", {
    path: path.join(WORK, "纪要.md").replace(/\//g, "\\"),
    oldText: "- 第一条",
    newText: "- 改过的第一条",
  });
  out.edit = { ok: edited.ok, line: edited.line };
  out.fileAfterEdit = fs.existsSync(path.join(WORK, "纪要.md")) ? fs.readFileSync(path.join(WORK, "纪要.md"), "utf8") : "(没有这个文件)";

  /* ── ⑥⑦ 跑命令：真写一个文件出来 + 拿回退出码 ── */
  const target = path.join(WORK, "由命令写出.txt").replace(/\//g, "\\");
  const ran = await runTool("run_command", {
    command: `node -e "require('fs').writeFileSync(process.argv[1],'by-command')" "${target}"`,
    workdir: WORK.replace(/\//g, "\\"),
  });
  out.command = { ok: ran.ok, line: ran.line, exitCode: ran.exitCode, text: String(ran.text ?? "").slice(0, 200) };
  out.commandFile = fs.existsSync(path.join(WORK, "由命令写出.txt")) ? fs.readFileSync(path.join(WORK, "由命令写出.txt"), "utf8") : "(没有这个文件)";
  const bad = await runTool("run_command", { command: "exit 7", workdir: WORK.replace(/\//g, "\\") });
  out.exitCode7 = bad.exitCode ?? null;

  /* ── ⑧ 越界：工作目录不在授权里 ── */
  const escape = await runTool("run_command", { command: "echo x", workdir: "C:\\Windows" });
  out.outside = { ok: escape.ok, error: String(escape.error ?? "") };

  /* ── ⑨ 界面上列着这个授权 ── */
  await page.locator('[data-testid="wb-composer-add"]').click();
  await page.waitForTimeout(500);
  out.menuItems = await page.$$eval('[data-testid^="wb-workspace"]', (els) =>
    els.map((e) => (e.getAttribute("data-testid") ?? "") + "=" + (e.textContent ?? "").trim().slice(0, 40)),
  );
  out.menuShot = await shot(page, "workspace-menu.png");

  /* ── ⑩ 撤销之后工具立刻碰不到 ── */
  const revoked = await page.evaluate(
    (dir) => globalThis.shell.workspace.remove(dir),
    WORK.replace(/\//g, "\\"),
  );
  out.afterRevoke = revoked?.dirs ?? null;
  const afterRevoke = await runTool("list_dir", { path: WORK.replace(/\//g, "\\") });
  out.listAfterRevoke = { ok: afterRevoke.ok, error: String(afterRevoke.error ?? "") };

  await b.close();
} catch (e) {
  out.error = String(e).split("\n")[0];
} finally {
  console.log(JSON.stringify(out, null, 2));
  if (child) await killTree(child);

  const bad = [];
  if (out.error) bad.push("异常: " + out.error);

  if (!out.listDir?.ok) bad.push("① list_dir 看不了工作区：" + (out.listDir?.line ?? out.listDir?.text));
  else {
    if (!out.listDir.text.includes("README.md")) bad.push("① 列表里没有 README.md：" + out.listDir.text.slice(0, 200));
    if (!out.listDir.text.includes("src/")) bad.push("① 列表里没有 src/ 目录");
  }

  if (!out.search?.ok) bad.push("② search_files 找不了：" + out.search?.line);
  else {
    if (!out.search.text.includes("README.md:3:")) bad.push("② 命中没带路径与行号：" + out.search.text.slice(0, 200));
    if (!out.search.text.includes("src/main.ts:1:")) bad.push("② 没搜到 src/main.ts");
  }

  if (!out.read?.ok || !out.read.text.includes("星辰")) bad.push("③ read_file 读不到正文：" + out.read?.text);

  if (!out.write?.ok) bad.push("④ write_file 说写不了：" + out.write?.line);
  if (out.fileOnDisk !== "# 纪要\n\n- 第一条\n") bad.push("④ 磁盘上的文件不对：" + JSON.stringify(out.fileOnDisk));

  if (!out.edit?.ok) bad.push("⑤ edit_file 说改不了：" + out.edit?.line);
  if (out.fileAfterEdit !== "# 纪要\n\n- 改过的第一条\n") bad.push("⑤ 改完的磁盘内容不对：" + JSON.stringify(out.fileAfterEdit));

  if (!out.command?.ok) bad.push("⑥ run_command 说跑不了：" + out.command?.line);
  if (out.commandFile !== "by-command") bad.push("⑥ 命令的副作用没落到磁盘：" + JSON.stringify(out.commandFile));
  if (out.exitCode7 !== 7) bad.push(`⑦ 退出码没带回来：${JSON.stringify(out.exitCode7)}`);

  if (out.outside?.ok !== false) bad.push("⑧ 授权范围外的 workdir 竟然跑起来了");
  else if (!String(out.outside.error).includes("授权")) bad.push("⑧ 拒绝理由没说清「授权」：" + out.outside.error);

  if (!(out.menuItems ?? []).some((t) => t.startsWith("wb-workspace-workspace-dir"))) {
    bad.push("⑨ 输入区菜单里没列出这个授权：" + JSON.stringify(out.menuItems));
  }
  if (!Array.isArray(out.afterRevoke) || out.afterRevoke.length !== 0) {
    bad.push("⑩ 撤销之后列表没空：" + JSON.stringify(out.afterRevoke));
  }
  if (out.listAfterRevoke?.ok !== false) bad.push("⑩ 撤销之后工具竟然还能碰那个目录");

  if (bad.length) {
    console.error("✗ " + bad.join("；"));
    process.exitCode = 1;
  } else {
    console.log(
      "✓ agent 真能在工作区里干活：看目录 / 找内容 / 读 / 写 / 改 / 跑命令（副作用真落盘、退出码带回）/ 越界被拒 / 授权可见且撤销后立刻失效",
    );
  }
}
