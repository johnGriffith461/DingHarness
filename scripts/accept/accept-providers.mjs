// provider 可用性**诚实度**（2026-10-16 按现界面重写）—— 常驻回归。
//
// ## 这一条的历史（先说清楚，免得又被人"复活"成旧样子）
//
// 它原来整条建在**画布对话侧栏**上（`wb-canvas-chat-toggle` → 点 `probe-providers` 真探测 →
// 读 `.chat-provider select` 的标签）。那套界面（`src/chat/ChatSidebar.tsx`）后来被拆掉了，
// 脚本点哪儿都不响 —— 于是竖了墓碑（kind=retired），并在墓碑里**如实注明一件事**：
// 「真调用成功过 → 界面标出已验证」这条**没有别的验收在盯**。
//
// 2026-10-16 按**现在的界面**把它重写回来（设置 →「模型」页 —— 探测的结论就落在那一列状态上）。
// 现在这条覆盖的是原意里最要紧的那半个：
//
//   ① **状态是真的**：配了密钥的那家写「有密钥」、没密钥的写「无密钥」——
//      不许出现"全都能用"这种假话；
//   ② ⭐ **真调用成功过才升级成「已验证」**：开跑时（全新数据目录、没调过任何模型）
//      那一家**不许**已经写着「已验证」；真发一轮成功之后**必须**变成「已验证」。
//      —— 这一条就是原来"没有替代品"的那个缺口。
//
// ## 为什么不点"探测"按钮了
//
// 现界面里**没有那颗按钮**了：探测结论（`electron/ipc/aiProbe.ts` → `provider-probe.json`）
// 现在由「真实调用成功时刷新」（`health.markOk`）写入，没有"手动批量探测"的入口。
// 所以触发方式从"点按钮"换成"真跑一轮" —— 判据（成功过才显示已验证）一字未改。
//
// ⚠️ 批跑自带本地假通道并把 `strata` 指过去（`DSH_NO_REAL_MODEL=1` 管着零出网），
// 所以"真发一轮"在批跑里是**确定**的、不花钱。
import { chromium } from "playwright";
import {
  bootApp,
  connectWithRetry,
  failOnMarks,
  finishedTurns,
  freshDir,
  killTree,
  pickPort,
  verdict,
  waitForPage,
  waitTurnEnd,
} from "./harness.mjs";

/* ⚠️ 与全仓其它验收一致的"印了 ✗ 就真的红"收口（审计 G15） */
failOnMarks();

const DATA = ".verify/providers-data";
if (!(await freshDir(DATA))) {
  console.error("✗ 数据目录 " + DATA + " 删不掉 —— 先手工关掉占着它的 Electron");
  process.exit(1);
}

const booted = await bootApp({ port: await pickPort([12390]), dataDir: DATA, timeoutMs: 40_000 });
if (!booted.ok) {
  console.error("[诊断] 应用输出尾部：" + (booted.getLog() || "(空)").slice(-1200));
  await killTree(booted.child);
  process.exit(1);
}
const browser = await connectWithRetry(chromium, `http://127.0.0.1:${booted.port}`);
const page = await waitForPage(browser);
if (!page) throw new Error("应用起了但一个页面都没建（见 harness 的 NO_PAGE_HINT 说明）");
await page.waitForSelector('[data-testid="wb"]', { timeout: 25000 });
await page.waitForTimeout(1500);

/** 打开 设置 →「模型」子页（入口与 accept-settings-models 同一套）。 */
const openModelsPage = async () => {
  if ((await page.locator('[data-testid="wb-setpage-models"]').count()) === 0) {
    if ((await page.locator('[data-testid="wb-settings"]').count()) === 0) {
      await page.locator('[data-testid="wb-account"]').click();
      await page.waitForTimeout(500);
      await page.locator('[data-testid="wb-acct-settings"]').click();
      await page.waitForTimeout(900);
    }
    await page.locator('[data-testid="wb-set-模型"]').click();
    await page.waitForTimeout(900);
  }
  return (await page.locator('[data-testid="wb-setpage-models"]').count()) > 0;
};

/** 读左列每一家的状态（文案是「有密钥 / 已验证 / 无密钥」之一）。 */
const readStates = async () => {
  const out = {};
  for (const id of ["strata", "deepseek", "openai"]) {
    const row = page.locator(`[data-testid="wb-modelset-provider-${id}"]`);
    if ((await row.count()) === 0) continue;
    const text = ((await row.first().innerText()) ?? "").replace(/\s+/g, " ").trim();
    out[id] = text.includes("已验证")
      ? "已验证"
      : text.includes("无密钥")
        ? "无密钥"
        : text.includes("有密钥")
          ? "有密钥"
          : "其它(" + text.slice(0, 24) + ")";
  }
  return out;
};

const out = {};
try {
  /* ① 开跑时：设置·模型页打不开 / 列不出 provider 就直接红（下面两条判据都要读它） */
  out.pageOpened = await openModelsPage();
  out.rowCount = await page.locator('[data-testid^="wb-modelset-provider-"]').count();
  out.before = await readStates();
  /* 关掉设置，回首页发一轮真对话（批跑里走本地假通道） */
  if ((await page.locator('[data-testid="wb-settings-close"]').count()) > 0) {
    await page.locator('[data-testid="wb-settings-close"]').click();
    await page.waitForTimeout(400);
  }
  await page.locator('[data-testid="wb-nav-home"]').click();
  await page.waitForTimeout(700);
  const before = await finishedTurns(page);
  await page.locator('[data-testid="wb-composer-input"]').fill("只回复两个字：收到");
  await page.locator('[data-testid="wb-send"]').click();
  /* 等**这一轮真的结束**（会话记录里的 done），不是"气泡出现就读"（审计 G108 同族） */
  await waitTurnEnd(page, before, 120_000);
  out.turnDone = true;

  /* ② 跑过一轮之后再看那一列：成功调过的那家应当升成「已验证」 */
  out.afterOpened = await openModelsPage();
  out.after = await readStates();
  await page.screenshot({ path: ".verify/shots-final/providers-status.png", timeout: 8000 }).catch(() => undefined);

  await browser.close();
} catch (e) {
  out.error = String(e).slice(0, 400);
} finally {
  console.log(JSON.stringify(out, null, 2));
  await killTree(booted.child);

  const bad = [];
  if (out.error) bad.push("异常: " + out.error);
  if (!out.pageOpened) bad.push("设置里点「模型」没打开子页（wb-setpage-models 不在）—— 状态压根没地方看");
  if (!(out.rowCount >= 2)) bad.push(`左列只列出 ${out.rowCount} 家 provider（不像真列表）`);

  /* ① 状态是真的：没密钥的必须写「无密钥」（不许"全都能用"）*/
  const beforeStates = out.before ?? {};
  if (!beforeStates.strata) bad.push("左列里没有批跑那把唯一有密钥的通道（strata）");
  else if (beforeStates.strata !== "有密钥") {
    bad.push(`还没调过任何模型，strata 却不写「有密钥」而是「${beforeStates.strata}」—— 状态不是真的`);
  }
  if (beforeStates.deepseek && beforeStates.deepseek !== "无密钥") {
    bad.push(`deepseek 这把没有密钥，界面却写「${beforeStates.deepseek}」—— 在假装可用`);
  }

  /* ② ⭐ 真调用成功过才升级（原来"没有替代品"的那半个）*/
  const afterStates = out.after ?? {};
  if (!out.turnDone) bad.push("那一轮没跑完（会话记录里没等到 done）—— 后面的判据无从谈起");
  else if (afterStates.strata !== "已验证") {
    bad.push(`真跑通一轮之后，strata 没有升成「已验证」而是「${afterStates.strata}」—— 成功没记到界面上`);
  }

  verdict(bad, "provider 状态诚实：没密钥的写「无密钥」/ 真跑通一轮之后那一家升成「已验证」");
}
