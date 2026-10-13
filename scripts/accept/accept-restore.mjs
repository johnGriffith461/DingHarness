import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";
import { NO_PAGE_HINT, bootApp, freshDir, killTree, shot, waitForPage } from "./harness.mjs";

/**
 * 验收：**重启之后，历史里的东西还在不在**（§177）。
 *
 * ## 这条**不调模型**（进批跑）
 *
 * 起因：§176 撞到 `normalizeTask` 漏了 `tools`，§177 又撞到它漏了 `note`。
 * 两次都是**同一类毛病**：声明的字段在恢复时没跟上。所以这条验收
 * 专门盯"落盘 → 重启 → 界面上还看得见"这条链。
 *
 * ## 断言
 *
 * ① ⭐ **压缩摘要那条还在**（`note`）—— §149 写它的理由就是"刷新不能没"
 * ② ⭐ **工具留痕还在**（`tools`，§176 的回归哨兵）
 * ③ 工具留痕里的**参数**也还在（`input` 一起恢复）
 * ④ 评价（`rating`）还在
 * ⑤ 上次关窗口时还在跑的任务，恢复后是 `failed` 且写明"上次关闭时被中断"
 *    （这是原有口径，顺带钉住 —— 免得以后有人"顺手改好"改成 running）
 */
const DATA = "D:/DoubaoWorkClone/.verify/restore-data";
if (!(await freshDir(DATA))) {
  console.error("✗ 数据目录 " + DATA + " 删不掉 —— 先手工关掉占着它的 Electron");
  process.exit(1);
}
fs.mkdirSync(DATA, { recursive: true });

const NOTE = "更早的 7 条对话已压缩为摘要";
const CALL_ID = "call-restored-1";

fs.writeFileSync(
  path.join(DATA, "tasks.json"),
  JSON.stringify(
    [
      {
        id: "t-restore",
        title: "重启之后还在不在",
        brief: "看看历史",
        createdAt: Date.now() - 120_000,
        stage: "done",
        startedAt: Date.now() - 119_000,
        finishedAt: Date.now() - 118_000,
        steps: [
          { id: "s-0", role: "user", text: "看看历史", at: Date.now() - 120_000 },
          {
            id: "s-1",
            role: "assistant",
            text: "这一段前面被压缩过。",
            at: Date.now() - 118_000,
            cost: 0.48,
            askedWith: "看看历史",
            rating: "up",
            tools: [
              {
                toolCallId: CALL_ID,
                name: "memory_save",
                ok: true,
                line: "⚙ 记忆：已保存，当前 1 条（写入「用户叫阿岩」）",
                input: { text: "用户叫阿岩" },
              },
            ],
            note: NOTE,
          },
        ],
      },
      {
        /* 一条"上次关窗口时还在跑"的任务 —— 恢复口径的哨兵 */
        id: "t-interrupted",
        title: "上次没跑完的",
        brief: "查个东西",
        createdAt: Date.now() - 60_000,
        stage: "running",
        startedAt: Date.now() - 59_000,
        steps: [{ id: "s-0", role: "user", text: "查个东西", at: Date.now() - 60_000 }],
      },
    ],
    null,
    2,
  ),
  "utf8",
);

const PORT = 9329;
const out = {};
let child = null;
let ok = false;
let getLog = () => "";

const boot = async () => {
  const r = await bootApp({ port: PORT, dataDir: DATA, timeoutMs: 30000 });
  child = r.child;
  ok = r.ok;
  getLog = r.getLog;
  return ok;
};

try {
  if (!(await boot())) {
    console.error("[诊断] 应用输出尾部：\n" + (getLog() || "(空)").slice(-1200));
    await killTree(child);
    process.exit(1);
  }

  const b = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
  const page = await waitForPage(b);
  if (!page) throw new Error(NO_PAGE_HINT);
  await page.waitForSelector('[data-testid="wb"]', { timeout: 20000 });

  await page.locator('[data-testid="wb-nav-home"]').click();
  await page.waitForTimeout(800);

  /* ⑤ 被中断那条：先从列表上看状态 */
  out.interruptedText = await page.evaluate(() => {
    const row = document.querySelector('[data-testid="wb-recent-t-interrupted"]');
    return row ? (row.textContent ?? "").replace(/\\s+/g, " ").trim() : "";
  });

  /*
   * ⑤ 上次没跑完那条：**状态不在列表行上**（那一行只有标题与图标），
   * 详情里才写。先打开它看那句说明 —— 这也是"如实标失败"的落点。
   */
  await page.locator('[data-testid="wb-recent-t-interrupted"]').click();
  await page.waitForTimeout(1200);
  out.interruptedActivity = await page.evaluate(
    () => document.querySelector(".wb-activity")?.textContent?.trim() ?? "",
  );

  /* 再打开那条正常的历史 */
  await page.locator('[data-testid="wb-recent-t-restore"]').click();
  await page.waitForTimeout(1500);

  out.note = await page.evaluate(
    () => document.querySelector('[data-testid="wb-note-s-1"]')?.textContent?.trim() ?? "",
  );
  out.toolLine = await page.evaluate(
    (id) => document.querySelector(`[data-testid="wb-tool-line-${id}"]`)?.textContent?.trim() ?? "",
    CALL_ID,
  );
  out.costShown = await page.evaluate(() => document.body.textContent?.includes("0.48") ?? false);
  out.shot = await shot(page, "restore.png");

  await b.close();
} catch (e) {
  out.error = String(e).slice(0, 300);
} finally {
  console.log(JSON.stringify(out, null, 2));
  await killTree(child);

  const bad = [];
  if (out.error) bad.push("异常: " + out.error);

  /* ① 压缩摘要 */
  if (out.note !== NOTE) bad.push(`⭐ 重启之后压缩摘要那条没了：${JSON.stringify(out.note)}`);
  /* ②③ 工具留痕与参数 */
  if (!(out.toolLine ?? "").includes("已保存")) bad.push(`⭐ 重启之后工具留痕没了：${JSON.stringify(out.toolLine)}`);
  if (!(out.toolLine ?? "").includes("阿岩")) bad.push(`重启之后留痕里的参数没了：${JSON.stringify(out.toolLine)}`);
  /* ④ 评价 / 消耗 */
  if (!out.costShown) bad.push("消耗（0.48）没恢复出来");
  /* ⑤ 被中断那条 */
  if (!(out.interruptedActivity ?? "").includes("上次关闭时被中断")) {
    bad.push(`上次没跑完的任务没说清是被中断的：${JSON.stringify(out.interruptedActivity)}`);
  }

  if (bad.length) {
    console.error("✗ " + bad.join("；"));
    process.exitCode = 1;
  } else {
    console.log("✓ 重启恢复成立：压缩摘要在 / 工具留痕与参数在 / 消耗在 / 被中断的任务如实标失败");
  }
}
