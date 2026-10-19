import { chromium } from "playwright";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { NO_PAGE_HINT, bootApp, connectWithRetry, freshDir, killTree, shot, waitForPage } from "./harness.mjs";

/**
 * 验收 T-01：**真 provider** 跑「改文件 → 审批 → approvals 表 → 审阅面板」整条链。
 *
 * ## 为什么必须是真 provider（主人 2026-10-19 明确要求）
 *
 * 这条要证的是"模型真的会调工具、闸门真的拦得住、批准后真的落盘"。
 * 假通道只能证明"我们把自己造的字段塞进自己造的对象" —— 上一轮实测过：
 * 适配层静默丢字段时假通道全绿，换真 provider 立刻露馅。
 *
 * ## 判据（全部可观察）
 *
 * ① 审批出现前盘上没有文件（闸门不是摆设）；
 * ② 点「允许」之后文件真的写进去，内容一字不差；
 * ③ 任务**只有一个**会话，且 id 带 `task-` 前缀（T-01 修的就是双轨制）；
 * ④ `approvals` 表那一条是 `approved` 且 `decided_by` 非空（直接读库，不看界面）；
 * ⑤ 事件流里也有同一次批准（表与流一致）；
 * ⑥ 审阅面板读同一会话，列出刚写的文件。
 *
 * ## 闸与预算
 *
 * - 必须 `--yes-spend`；`DING_NO_REAL_MODEL` / `DSH_NO_REAL_MODEL` 开着就拒跑；
 * - 模型固定 `tokenrhythm/deepseek-v4.1-flash-1017`（1M 窗口，经 models.json 声明）；
 * - 单任务预算按 token 记（默认 20 万），超了算失败。
 *
 * 用法：
 *   node --import tsx scripts/accept/accept-approvals-audit-real.mjs --yes-spend
 */
const MODEL = process.env.ACCEPT_MODEL ?? "deepseek-v4.1-flash-1017";
const PROVIDER = process.env.ACCEPT_PROVIDER ?? "tokenrhythm";
const MAX_TOKENS = Number(process.env.ACCEPT_MAX_TOKENS ?? 200_000);
const LOG = path.join(process.cwd(), ".verify", "accept-approvals-audit-real.log");

if (!process.argv.includes("--yes-spend")) {
  process.stdout.write(
    `计划：真模型 ${PROVIDER}/${MODEL} 在桌面里跑「写文件 → 审批 → approvals 表 → 审阅」\n` +
      `  预算：单任务 ≤ ¥2（按 token 闸 ${MAX_TOKENS}；价格不可核实，不换算金额）\n` +
      `  确认后加 --yes-spend\n`,
  );
  process.exit(2);
}
if (process.env.DING_NO_REAL_MODEL?.trim() || process.env.DSH_NO_REAL_MODEL?.trim()) {
  process.stderr.write("零出网闸开着（DING_NO_REAL_MODEL / DSH_NO_REAL_MODEL）：先取消再跑\n");
  process.exit(2);
}
const realCreds = path.join(os.homedir(), ".ding", ".credentials.yaml");
if (!fs.existsSync(realCreds)) {
  process.stderr.write(`没有真实凭据文件：${realCreds}\n`);
  process.exit(2);
}

const DATA = ".verify/trust-real-data";
if (!(await freshDir(DATA))) {
  console.error("✗ 数据目录 " + DATA + " 删不掉 —— 先手工关掉占着它的 Electron");
  process.exit(1);
}
fs.mkdirSync(DATA, { recursive: true });
/*
 * ⚠️ 落点必须是**授权目录**：桌面能写的只有 userData 下的 drive/产物/导出 与用户授权的
 * 工作区。写到 userData 根上会被白名单拒绝（真机实测过：审批显示批准、盘上什么都没有）。
 */
const TARGET = path.join(process.cwd(), DATA, "drive", "trust-audit.txt");
fs.mkdirSync(path.dirname(TARGET), { recursive: true });
const MARKER = `trust-audit-${Date.now().toString(36)}`;
const PORT = 9421;
const out = {};
let child = null;

/* 声明模型能力（1M 窗口）：不声明的话预算会退到保守默认，验收口径失真 */
fs.writeFileSync(
  path.join(DATA, "models.json"),
  JSON.stringify(
    {
      version: 1,
      rules: [
        {
          type: "exact",
          providerId: PROVIDER,
          modelId: MODEL,
          manual: true,
          config: {
            properties: { contextWindow: 1_000_000, supportsToolCall: true, inputFormat: { supportsText: true } },
          },
        },
      ],
    },
    null,
    2,
  ),
  "utf8",
);
/* 钉住模型：首跑向导不再出现，新任务直接走这条通道 */
fs.writeFileSync(
  path.join(DATA, "settings.json"),
  JSON.stringify({ __schema: 1, data: { pinnedModel: `${PROVIDER}/${MODEL}` } }),
  "utf8",
);

try {
  /*
   * ⚠️ 真 provider：把批跑那套零出网环境变量**清掉**（这脚本不经过 verify-acceptances）。
   * 只把凭据指向真实文件（不复制、不打印）。
   */
  delete process.env.DSH_NO_REAL_MODEL;
  delete process.env.DING_NO_REAL_MODEL;
  delete process.env.STRATA_BASE_URL;
  delete process.env.STRATA_API_KEY;
  process.env.DSH_CREDENTIALS_FILE = realCreds;

  const booted = await bootApp({ port: PORT, dataDir: DATA, timeoutMs: 40000 });
  child = booted.child;
  if (!booted.ok) {
    console.error("[诊断] 应用输出尾部：\n" + (booted.getLog() || "(空)").slice(-1500));
    process.exit(1);
  }
  const browser = await connectWithRetry(chromium, `http://127.0.0.1:${PORT}`);
  const page = await waitForPage(browser);
  if (!page) throw new Error(NO_PAGE_HINT);
  await page.waitForSelector('[data-testid="wb"]', { timeout: 20000 });
  await page.waitForTimeout(1500);

  out.firstRunVisible = (await page.locator('[data-testid="wb-firstrun"]').count()) > 0;

  /* 档位切到「每步确认」：写文件必被拦下 */
  await page.evaluate(() => localStorage.setItem("dsh-canvas.confirm-mode", "每步确认"));
  const input = page.locator('[data-testid="wb-composer-input"]');
  await input.click();
  await input.fill(
    `请调用 write_file 工具，把文件写到「${TARGET}」，内容写「${MARKER}」。只做这一件事，不要做别的。`,
  );
  await page.locator('[data-testid="wb-send"]').click();

  /*
   * 等**那一次 write_file** 的「允许」出现（不是"第一个允许"）。
   * 真模型会先 list_dir / read_file —— 那些在「每步确认」下同样被拦，
   * 点错一条就变成"批了读、没批写"，验收结论会是假的。
   */
  /*
   * ⚠️ 会话是**这一轮开始之后**才建出来的：立刻 list 会读到空数组，
   * 于是后面一直在读空会话（实测踩到：模型明明调了 write_file，脚本说没有）。
   * 这里轮询到 task- 会话出现为止。
   */
  let taskSid = "";
  const sidDeadline = Date.now() + 60_000;
  while (Date.now() < sidDeadline && !taskSid) {
    const sessionList = await page.evaluate(async () => {
      const list = await window.shell.session.list("all");
      return list.map((s) => s.sessionId);
    });
    taskSid = sessionList.find((id) => String(id).startsWith("task-")) ?? "";
    if (!taskSid) await page.waitForTimeout(400);
  }
  if (!taskSid) throw new Error("这一轮没有建出 task- 会话（连请求都没发出去？）");
  out.taskSession = taskSid;
  let writeCallId = "";
  const pendingDeadline = Date.now() + 180_000;
  while (Date.now() < pendingDeadline && !writeCallId) {
    const got = await page.evaluate(async (sid) => {
      const loaded = await window.shell.session.load(sid);
      return loaded?.records ?? [];
    }, taskSid);
    const calls = new Map();
    for (const r of got) if (r.type === "tool-call") calls.set(r.toolCallId, r.toolName);
    for (const r of got) {
      if (r.type !== "tool-result") continue;
      if (calls.get(r.toolCallId) !== "write_file") continue;
      if (r.output && typeof r.output === "object" && r.output.pending === true) writeCallId = r.toolCallId;
    }
    if (!writeCallId) await page.waitForTimeout(400);
  }
  if (!writeCallId) throw new Error("模型始终没有发起 write_file（看日志里的正文与轨迹）");
  out.writeCallId = writeCallId;
  out.pendingSeen = true;
  if (fs.existsSync(TARGET)) throw new Error("还没批准，文件就已经被写了（闸门泄漏）");
  out.fileAbsentBeforeAllow = true;
  await shot(page, ".verify/approvals-audit-real-pending.png");

  await page.locator(`[data-testid="wb-tool-allow-${writeCallId}"]`).click();
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline && !fs.existsSync(TARGET)) await page.waitForTimeout(400);
  out.fileWritten = fs.existsSync(TARGET);
  out.fileContent = out.fileWritten ? fs.readFileSync(TARGET, "utf8") : "";
  await page.waitForTimeout(2500);
  await shot(page, ".verify/approvals-audit-real.png");

  /* ① 会话只有一条 task- 会话 */
  const sessions = await page.evaluate(async () => {
    const list = await window.shell.session.list("all");
    return list.map((s) => ({ id: s.sessionId, kind: s.kind }));
  });
  const taskSessions = sessions.filter((s) => String(s.id).startsWith("task-"));
  out.taskSessions = taskSessions.map((s) => s.id);
  out.singleTaskSession = taskSessions.length === 1;
  const taskSessionId = taskSessions[0]?.id ?? "";

  /* 用量（真 provider 的 token） */
  out.usage = await page.evaluate(async (sessionId) => {
    const got = await window.shell.session.load(sessionId);
    const done = (got?.records ?? []).filter((r) => r.type === "done" && r.usage);
    const last = done[done.length - 1]?.usage ?? null;
    return last;
  }, taskSessionId);
  out.tokens = Number(out.usage?.inputTokens ?? 0) + Number(out.usage?.outputTokens ?? 0);

  /* ② 审阅面板读同一会话 */
  out.review = await page.evaluate(async (sessionId) => {
    const got = await window.shell.review.list(sessionId);
    return { ok: got?.ok, files: (got?.files ?? []).map((f) => f.path), summary: got?.summary, error: got?.error };
  }, taskSessionId);
  out.reviewHasTarget = (out.review?.files ?? []).some((p) => path.resolve(p) === path.resolve(TARGET));

  /* ③ approvals 表（直接读库） */
  const dbPath = path.join(process.cwd(), DATA, "sessions.db");
  const db = new DatabaseSync(dbPath);
  try {
    out.approvals = db.prepare("SELECT session_id, tool_call_id, state, decided_by FROM approvals").all();
  } finally {
    db.close();
  }
  const row = (out.approvals ?? []).find((r) => String(r.session_id) === taskSessionId);
  out.approvalRow = row ?? null;
  out.approvalState = row?.state ?? null;
  out.approvalDecidedBy = row?.decided_by ?? null;
  out.approvalSessionPrefixed = Boolean(row && String(row.session_id).startsWith("task-"));

  /* ④ 事件流里的批准 */
  out.eventStates = await page.evaluate(async (sessionId) => {
    const got = await window.shell.session.load(sessionId);
    return (got?.records ?? [])
      .filter((r) => r.type === "approval")
      .map((r) => ({ approved: r.approved === true, toolCallId: r.toolCallId }));
  }, taskSessionId);
} catch (error) {
  out.error = error instanceof Error ? error.message : String(error);
} finally {
  await killTree(child);
  mkdirSafe(path.dirname(LOG));
  fs.writeFileSync(LOG, [new Date().toISOString(), `model=${PROVIDER}/${MODEL}`, JSON.stringify(out, null, 2)].join("\n"), "utf8");
}

function mkdirSafe(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    /* ignore */
  }
}

const checks = [
  ["没有误弹首跑向导（模型已钉住）", out.firstRunVisible === false],
  ["审批出现前文件没有被写（闸门真的拦了）", out.fileAbsentBeforeAllow === true],
  ["批准后文件真的写进了盘，内容一字不差", out.fileWritten === true && out.fileContent?.trim() === MARKER],
  ["任务只有一个会话（不再有裸 id 那条）", out.singleTaskSession === true],
  ["那个会话 id 带 task- 前缀", (out.taskSessions ?? []).length > 0],
  ["approvals 表里那一条是 approved", out.approvalState === "approved"],
  ["approvals 表里 decided_by 非空", Boolean(out.approvalDecidedBy)],
  ["approvals 行的 session_id 带 task- 前缀", out.approvalSessionPrefixed === true],
  ["事件流里也有同一次批准（表与流一致）", (out.eventStates ?? []).some((e) => e.approved === true)],
  ["审阅面板列出刚写的文件", out.reviewHasTarget === true],
  [`token 在预算内（${out.tokens ?? 0} ≤ ${MAX_TOKENS}）`, (out.tokens ?? 0) <= MAX_TOKENS],
];

if (out.error) process.stdout.write(`\n异常：${out.error}\n`);
let failed = 0;
for (const [name, ok] of checks) {
  if (!ok) failed += 1;
  process.stdout.write(`${ok ? "✓" : "✗"} ${name}\n`);
}
process.stdout.write("\n" + JSON.stringify(out, null, 2) + "\n");
process.stdout.write(
  `\n${failed === 0 ? "✓ 全部通过" : `✗ ${failed} 项未通过`}（${checks.length} 项：真 provider 审批链路 / 会话身份 / 审阅）\n` +
    `日志：${LOG}\n`,
);
process.exit(failed === 0 ? 0 : 1);
