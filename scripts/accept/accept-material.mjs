import { chromium } from "playwright";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { connectWithRetry, failOnMarks, freshDir, pickPort, readAllSessionRecords, verdict } from "./harness.mjs";

/* ⚠️ 2026-10-16（审计 G15）：这份脚本原来只把 ✗ 印出来、从不改退出码 —— 批跑里等于没测 */
failOnMarks();

/**
 * 「@ 添加资料」——把文件交给 agent（2026-10-14）。
 *
 * ## 验的是"内容真的进了请求"，不是"菜单里有这一项"
 * 输入区那条占位文案是本体原话（「发消息或创建任务... / 使用技能 @ 添加资料」），
 * 而 `@` 在这之前只出常用语 —— **界面承诺过、功能没做**。
 * 补上之后，唯一值得断的后果是：**发出去的那一轮请求里真的有文件内容**。
 *
 * 请求体落在**会话日志**里（`electron/ipc/ai.ts:157`：发与记在同一处，
 * 且在调用模型**之前**就写了）—— 所以这条**不需要模型**也能断：
 * 用空凭据文件让这一轮必定失败（不发网络请求），日志里照样有那条 request。
 *
 * ⚠️ 顺带断一条界面口径：**气泡里只显示用户自己写的那句话**，
 * 资料正文不该混进他说的话里（那是给模型的，不是给他看的）。
 */
const DATA = ".verify/material-data";
/* 2026-10-16（G02 同族）：裸 rmSync 在句柄还占着时会 EPERM 打死脚本 → 换 freshDir */
await freshDir(DATA);
/* 预置一份资料：内容里有**只有读到才知道**的标记 */
const MARK = "验收专用标记-7Q4Z";
fs.mkdirSync(path.join(DATA, "drive"), { recursive: true });
fs.writeFileSync(path.join(DATA, "drive", "季度总结.md"), `# 季度总结\n\n${MARK}\n营收增长 12%\n`, "utf8");

/*
 * 这一条只验"资料进没进请求体"，**不验模型回答**。
 *
 * 旧写法是"空凭据文件 → 这一轮必定失败，但请求照记"—— 那个前提在
 * 「provider 预检用 resolveSecret」之后不成立了：没有 key 时**连 request 都不会写**
 * （宿主在解析目标阶段就报错），于是读到 0 条 request，四个断言一起假红。
 *
 * 现在：有真实凭据就用真实的（请求一定会发出，模型回不回都不影响判据）；
 * 没有凭据才退回空文件（那种环境下这条会明确红，而不是静默）。
 */
const realKeys = path.join(os.homedir(), ".ding", ".credentials.yaml");
const EMPTY_KEYS = ".verify/material-keys-empty.yaml";
fs.writeFileSync(EMPTY_KEYS, "refs:\n", "utf8");
const KEYS_FILE = fs.existsSync(realKeys) ? realKeys : EMPTY_KEYS;

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
env.DSH_CANVAS_DATA_DIR = DATA;
env.DSH_CREDENTIALS_FILE = KEYS_FILE;

/* 这台机器的回环端口会随机连不上（见 harness.pickPort）→ 起之前先挑一个能用的。 */
const __port = await pickPort([12781]);
const child = spawn(
  "node_modules/electron/dist/electron.exe",
  [".", "--remote-debugging-port=" + __port],
  { cwd: ".", env, stdio: ["ignore", "ignore", "ignore"] },
);
await new Promise((r) => setTimeout(r, 9000));

const browser = await connectWithRetry(chromium, "http://127.0.0.1:" + __port);
const pages = browser.contexts()[0].pages();
const page = pages.find((p) => !p.url().startsWith("devtools://")) ?? pages[0];
await page.waitForSelector('[data-testid="wb"]', { timeout: 20000 });
await page.waitForTimeout(2000);

const report = {};
try {
  const input = page.locator('[data-testid="wb-composer-input"]');

  report.step = "打 @ 唤起选单";
  await input.click();
  await input.fill("@");
  await page.waitForTimeout(900);
  report.materialGroup = await page.locator('[data-testid="wb-material-group"]').count();
  report.materialItems = await page
    .$$eval('[data-testid^="wb-material-"]', (els) => els.map((e) => e.textContent?.trim() ?? ""));

  report.step = "点一份资料";
  await page.locator('[data-testid="wb-material-季度总结.md"]').click();
  await page.waitForTimeout(500);
  report.chipShown = await page.locator('[data-testid="wb-material-chips"]').count();
  report.chipText = await page.locator('[data-testid="wb-material-chip-季度总结.md"]').textContent().catch(() => null);
  /* 选完资料，选单应当收起来（不然挡住输入） */
  report.menuClosed = (await page.locator('[data-testid="wb-phrase-menu"]').count()) === 0;

  report.step = "写一句话并发送";
  await input.fill("把这份资料整理成三行要点");
  await page.locator('[data-testid="wb-send"]').click();
  /* 等这一轮收尾：发送键不再是「停止」 */
  await page.waitForFunction(() => !document.querySelector('[data-testid="wb-send-stop"]'), { timeout: 25000 });
  await page.waitForTimeout(1200);

  report.chipsAfterSend = await page.locator('[data-testid="wb-material-chips"]').count();
  /* 用户那句话在界面上（气泡）应当**只有他写的那句** */
  report.bubbleText = await page
    .locator('[data-testid="wb-task"] .wb-bubble-user')
    .first()
    .textContent()
    .catch(() => null);

  report.step = "读会话日志里的请求体";
  /*
   * ⚠️ 走应用的 IPC 读会话记录（`readAllSessionRecords`），**不读 sessions/*.jsonl**：
   * 存储在 Phase 4.3 换成了 SQLite，直接读文件永远是空的 ——
   * 而那样红出来的理由是"脚本读错了地方"，看着却像"资料没交给模型"。
   */
  /*
   * ⚠️ 轮询到出现 `request` 为止（最多 20 秒）。
   * 原来只等 1.2 秒读一次：`wb-send-stop` 可能还没出现就已消失，
   * 那一轮的 request 还没落盘 —— 实测读到 0 条，四个断言一起"假红"。
   */
  let records = [];
  let requestRecords = 0;
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    records = await readAllSessionRecords(page);
    requestRecords = records.filter((r) => r?.type === "request").length;
    if (requestRecords > 0) break;
    await page.waitForTimeout(600);
  }
  report.requestRecords = requestRecords;
  report.sessionFiles = records.length; // 名字留着（历史报告里有它），值改成"读到几条"
  let requestText = "";
  for (const rec of records) {
    if (rec.type !== "request") continue;
    for (const m of rec.messages ?? []) {
      if (m.role === "user") requestText += String(m.content ?? "") + "\n";
    }
  }
  /*
   * ── 这一轮**给模型下发了哪些工具**（2026-10-14 补）──
   *
   * 日志里的 `tools` 字段就是"模型够得着什么"。加它的起因是「读文件」工具：
   * 在此之前 agent 看不见用户提到的任何文件（只能编），而"工具到底有没有下发"
   * 事后没法查 —— 现在一条日志就能回答，顺带让这件事**可断言**（不需要模型真的调用）。
   */
  let toolsOffered = null;
  for (const rec of records) {
    if (rec.type === "request" && Array.isArray(rec.tools)) toolsOffered = rec.tools;
  }
  report.toolsOffered = toolsOffered;
  report.requestHasBlock = requestText.includes("【提到的文件】");
  report.requestHasPath = requestText.includes("季度总结.md");
  /*
   * ⚠️ 2026-10-16（审计 G08）：`report.requestHasMark` 在下面被**断言**却
   * **从来没有被赋值** —— `!undefined` 恒真，于是这条脚本**永远红**，
   * 而红的话术还写着"标记没送过去"，指错了方向。
   * 现在按 `MARK` 真判：marker 只存在于那份资料文件里，读了才知道。
   */
  report.requestHasMark = requestText.includes(MARK);
  report.requestSlice = requestText.slice(0, 200);
} catch (error) {
  report.error = `在「${report.step ?? "未知"}」这一步失败：${String(error).split(String.fromCharCode(10))[0]}`;
} finally {
  console.log(JSON.stringify(report, null, 2));

  const bad = [];
  if (report.error) bad.push(`异常：${String(report.error).slice(0, 200)}`);

  /* ① 选单里真的有「资料」这一栏，且列的是真文件 */
  if (!report.materialGroup) bad.push("⭐ `@` 选单里没有「资料」这一栏（占位文案承诺过它）");
  if (!(report.materialItems ?? []).some((t) => t.includes("季度总结.md"))) {
    bad.push(`资料栏里没有云盘里那份文件：${JSON.stringify(report.materialItems)}`);
  }
  /* ② 点一下能附着，而且选单会收起 */
  if (!report.chipShown) bad.push("选了资料之后输入区没有出现附件");
  if (!String(report.chipText ?? "").includes("季度总结.md")) bad.push(`附件上没写清是哪个文件：${JSON.stringify(report.chipText)}`);
  if (!report.menuClosed) bad.push("选完资料选单还开着（挡住输入）");

  /* ③ ⭐ 内容真的进了请求：标记、资料块、路径都在 */
  if (!report.requestHasBlock) bad.push("⭐ 发出去的请求里没有资料块（等于资料没交给模型）");
  if (!report.requestHasMark) bad.push("⭐ 请求里没有文件正文里的标记 —— 送过去的可能只是个文件名");
  if (!report.requestHasPath) bad.push("请求里没写清资料来自哪个文件（模型没法引用它）");

  /* ③b 工具下发：日志里要写清这一轮给了模型哪些工具，且「读文件」在里面 */
  if (!Array.isArray(report.toolsOffered)) {
    bad.push("会话日志里没记这一轮下发了哪些工具（tools 字段缺失）");
  } else {
    /*
     * `write_file` 也在里面（2026-10-14，§224）：它与 read_file / list_files 是一套 ——
     * 能读不能写的 agent 只能把产出吐在对话里。这里只断言"**这一轮真的下发给模型了**"
     * （不需要模型真去调用）；"写不写得进去"由 `writeTool.test.ts` 与
     * `shared/permissions.ts` 的 write 声明管。
     */
    for (const need of [
      "read_file",
      "list_files",
      "write_file",
      "edit_file",
      "search_files",
      "list_dir",
      "run_command",
      "memory_save",
      "canvas_add_node",
    ]) {
      if (!report.toolsOffered.includes(need)) {
        bad.push(`这一轮没给模型「${need}」（实际：${JSON.stringify(report.toolsOffered)}）`);
      }
    }
  }

  /* ④ 资料只属于这一轮：发完就摘掉；气泡里也只有用户写的那句话 */
  if (report.chipsAfterSend) bad.push("发送之后附件还挂着（下一轮会莫名其妙又带上）");
  if (String(report.bubbleText ?? "").includes("验收专用标记")) {
    bad.push("⭐ 资料正文混进了用户气泡（那是给模型看的，不是用户说的话）");
  }

  verdict(bad, "资料交接成立：@ 有资料栏 / 点选附着并收起选单 / 请求里真有文件内容与路径 / 发完即摘且不污染气泡");

  await browser.close().catch(() => undefined);
  child.kill();
  process.exit(process.exitCode ?? 0);
}
