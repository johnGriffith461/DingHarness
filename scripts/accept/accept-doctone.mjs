import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";
import { NO_PAGE_HINT, bootApp, freshDir, killTree, shot, waitForPage } from "./harness.mjs";

/**
 * 验收：**调整语气真的改了文风**（§168）。
 *
 * ## 为什么单独一条
 *
 * `accept-docformat.mjs` 验的是"菜单文案 + 格式变换"（**不调模型**，进批跑）。
 * 但"调整语气"那半边**必须真调一次模型**才知道成不成 ——
 * 它和「润色」走的是同一条路，而这一档的指令是新的（`toneInstruction`）。
 *
 * ## 断言
 *
 * ① 点「更学术」后正文**真的变了**（不是原样还回来却报成功）
 * ② 历史里多了一版，由来写着 **更学术**
 * ③ 磁盘上也跟着变了（不是只改了界面）
 *
 * ⚠️ 会真调模型（1 次）。
 */
const DATA = "D:/DoubaoWorkClone/.verify/doctone-data";
if (!(await freshDir(DATA))) {
  console.error("✗ 数据目录 " + DATA + " 删不掉 —— 先手工关掉占着它的 Electron");
  process.exit(1);
}

const PORT = 9320;
const { child, ok, getLog } = await bootApp({ port: PORT, dataDir: DATA, timeoutMs: 30000 });
if (!ok) {
  console.error("[诊断] 应用输出尾部：\n" + (getLog() || "(空)").slice(-1200));
  await killTree(child);
  process.exit(1);
}

/** 一段明显口语化的原文 —— 要求"更学术"才有活可干。 */
const ORIGINAL =
  "这个季度我们干得还行吧，反正就是把登录那个毛病修了，报表也搞出来了，还跟客户开了个会聊聊后面咋办。";

const out = {};
try {
  const b = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
  const page = await waitForPage(b);
  if (!page) throw new Error(NO_PAGE_HINT);
  await page.waitForSelector('[data-testid="wb"]', { timeout: 20000 });

  await page.locator('[data-testid="wb-nav-home"]').click();
  await page.waitForTimeout(600);
  await page.locator('[data-testid="wb-composer-add"]').click();
  await page.waitForTimeout(300);
  await page.locator('[data-testid="wb-add-doc"]').click();
  await page.waitForTimeout(1200);
  await page.locator('[data-testid="wb-doc-body"]').fill(ORIGINAL);
  await page.waitForTimeout(1000);
  out.before = await page.locator('[data-testid="wb-doc-body"]').inputValue();

  await page.locator('[data-testid="wb-doc-tone"]').click();
  await page.waitForTimeout(300);
  await page.locator('[data-testid="wb-doc-tone-academic"]').click();

  const deadline = Date.now() + 90000;
  let now = "";
  while (Date.now() < deadline) {
    await page.waitForTimeout(2000);
    now = await page.locator('[data-testid="wb-doc-body"]').inputValue();
    if (now && now !== out.before) break;
  }
  out.after = now;
  out.note = await page.evaluate(
    () => document.querySelector('[data-testid="wb-doc-note"]')?.textContent?.trim() ?? "",
  );
  await page.locator('[data-testid="wb-doc-history-btn"]').click();
  await page.waitForTimeout(400);
  out.reasons = await page.evaluate(() =>
    Array.from(document.querySelectorAll(".wb-doc-version-reason")).map((e) => (e.textContent ?? "").trim()),
  );
  await page.waitForTimeout(1200);
  out.diskBody = (JSON.parse(fs.readFileSync(path.join(DATA, "docs.json"), "utf8"))?.[0]?.body ?? "").slice(0, 40);
  out.shot = await shot(page, "doctone.png");

  await b.close();
} catch (e) {
  out.error = String(e).slice(0, 300);
} finally {
  console.log(JSON.stringify(out, null, 2));
  await killTree(child);

  const bad = [];
  if (out.error) bad.push("异常: " + out.error);

  if (!out.after || out.after === out.before) {
    bad.push("点了「更学术」正文没变 —— 模型没干活，或者结果没落回去");
  }
  if (!(out.reasons ?? []).includes("更学术")) {
    bad.push(`历史里没有「更学术」这一版：${JSON.stringify(out.reasons)}`);
  }
  if (!(out.diskBody ?? "").trim()) bad.push("磁盘上的正文是空的");
  else if (!out.after.includes((out.diskBody ?? "").slice(0, 10))) {
    bad.push("磁盘与界面不一致");
  }

  if (bad.length) {
    console.error("✗ " + bad.join("；"));
    process.exitCode = 1;
  } else {
    console.log("✓ 调整语气成立：点「更学术」真的重写了正文、历史记着由来、磁盘也跟上");
  }
}
