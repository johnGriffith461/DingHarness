import { chromium } from "playwright";
import {
  bootApp,
  connectWithRetry,
  failOnMarks,
  freshDir,
  killTree,
  pickPort,
  shot,
  waitForPage,
} from "./harness.mjs";

/* ⚠️ 2026-10-16（审计 G15）：这份脚本原来只把 ✗ 印出来、从不改退出码 —— 批跑里等于没测 */
failOnMarks();

/**
 * 验收：**这一轮失败之后的出路**（§187 界面体检点名的两处接线之一；**2026-10-16 按现界面重写**）。
 *
 * ## 为什么重写，而不是删掉
 *
 * 旧版验的是**画布里的聊天侧栏**（`chat-input` / `chat-ref-add` / `chat-retry-*` / `.chat-msg.is-error`）——
 * 那套界面在后来的改版里被拆掉了（"聊天那套拆掉之后直接问 aiClient"），
 * 于是它点的按钮一个都不在了：批跑里红的是**脚本过期**，不是产品坏了（§56 那种）。
 * 而它要守的那件事 —— "出了错之后用户有出路，且重试真的是同一问的重跑" ——
 * 现在落在工作台里，**没有别的脚本在盯**，所以按工作台的界面重写。
 *
 * ## 失败必须是**确定性的**（这条不连模型）
 *
 * 把通道指到一个**没人听的回环端口**：`STRATA_BASE_URL=http://127.0.0.1:59991/v1`。
 * 这一步同时满足三件事：
 *   · 回环地址 → 零出网闸放行（`DSH_NO_REAL_MODEL` 只拦远程），**一次真请求都不发**；
 *   · 连不上 → 必然失败：不依赖模型在不在、快不快、有没有配额；
 *   · 失败原因是"本机通道没起来"——用户真会撞见的那一种，不是编出来的。
 *
 * ## 断的是后果，不是"界面上有颗按钮"
 *
 *   ① 失败**说得清**：那一步的正文里有「出错了」+ 一句原因（不是空白红框）；
 *   ② 失败**有出路**：那一步带可点的「重新生成」（`wb-act-retry-<stepId>`）；
 *   ③ 重试是**同一问的重跑**：点完之后用户的提问**还是一句**（撤旧问答重发，不是再追加一遍）；
 *   ④ **不卡忙碌态**：失败落定后没有残留的停止键，输入框打上字之后发送键可用。
 */

const DATA = ".verify/retry-data";
/* Windows 上"上一条实例还占着句柄"时 `rmSync` 会 EPERM 把脚本打死（实测栽过）→ 走 freshDir */
await freshDir(DATA);

const DEAD_PORT = 59_991; /* 没人听的端口：连不上是这条脚本的**前提**，不是意外 */
const out = {};
const bad = [];
let booted = null;
let browser = null;

try {
  booted = await bootApp({
    port: await pickPort([12671]),
    dataDir: DATA,
    timeoutMs: 40_000,
    extraEnv: {
      /* 批跑会把 STRATA_BASE_URL 指向本地假通道 —— 这一条要的是**连不上**，所以覆盖掉它 */
      STRATA_BASE_URL: `http://127.0.0.1:${DEAD_PORT}/v1`,
      STRATA_API_KEY: "retry-local-fake",
      /* 单独跑时也钉文件后端（批跑整体就是 file）—— 免得断言的是另一条存储路 */
      DSH_STORE_BACKEND: "file",
    },
  });
  if (!booted.ok) {
    console.error("[诊断] 应用输出尾部：\n" + (booted.getLog() || "(空)").slice(-1200));
    await killTree(booted.child);
    process.exit(1);
  }

  browser = await connectWithRetry(chromium, `http://127.0.0.1:${booted.port}`);
  const page = await waitForPage(browser);
  if (!page) throw new Error("一个页面都没建出来");
  await page.waitForSelector('[data-testid="wb"]', { timeout: 20000 });
  await page.waitForTimeout(1500);

  const QUESTION = "这一句注定失败（本机通道没起来）";
  const users = () => page.$$eval(".wb-bubble-user", (els) => els.map((e) => (e.textContent ?? "").trim()));
  const assistantTexts = () =>
    page.$$eval(".wb-assistant-text", (els) => els.map((e) => (e.textContent ?? "").trim()));

  /**
   * 发一句、等**失败落定**。
   *
   * ⚠️ 等的是"正文里出现「出错了」"，不是固定 sleep —— 固定 sleep 是审计 G108 点名的那类假红源头。
   * （这一路失败**不会**留下 `done` 记录：请求根本没发出去，所以不能用 `waitTurnEnd` 那条判据。）
   */
  const waitFailure = async () => {
    const deadline = Date.now() + 90_000;
    let texts = [];
    while (Date.now() < deadline) {
      texts = await assistantTexts();
      if (texts.some((t) => t.includes("出错了"))) return texts;
      await page.waitForTimeout(400);
    }
    return texts;
  };
  const askAndWaitFailure = async () => {
    await page.locator('[data-testid="wb-composer-input"]').fill(QUESTION);
    await page.locator('[data-testid="wb-send"]').click();
    return waitFailure();
  };

  out.step = "第一次发送（注定失败）";
  out.afterFailure = await askAndWaitFailure();
  out.userBubblesAfterFailure = await users();
  out.stopLeftOver = await page.locator('[data-testid="wb-send-stop"]').count();

  /* ② 出路：失败那一步的「重新生成」 */
  const retryIds = await page.$$eval('[data-testid^="wb-act-retry-"]', (els) =>
    els.map((e) => e.getAttribute("data-testid") ?? ""),
  );
  out.retryIds = retryIds;
  out.step = "点「重新生成」";
  /*
   * ⚠️ 点完**只等**，不要再发一次 —— 第一版这里调的是 `askAndWaitFailure()`（又填又点发送），
   * 于是"用户提问变成 2 句"是我自己造的，差点把产品判成"撤旧问答没做"。
   * 「重新生成」按设计是**原地替换那一步**（`store.regenerate`：同一个 stepId 写回，
   * 用的是 `askedWith`），所以提问本来就该还是 1 句。
   */
  await page.locator(`[data-testid="${retryIds[0]}"]`).click();
  out.afterRetry = await waitFailure();
  out.userBubblesAfterRetry = await users();
  out.assistantCount = await page.locator(".wb-assistant").count();

  /* ④ 不卡忙碌态：输入框还能用（打字之后发送键可用）、没有残留的停止键 */
  await page.locator('[data-testid="wb-composer-input"]').fill("失败之后还能打字");
  await page.waitForTimeout(300);
  out.sendEnabledAfterTyping = !(await page.locator('[data-testid="wb-send"]').isDisabled());
  out.stopAfterRetry = await page.locator('[data-testid="wb-send-stop"]').count();
  await page.locator('[data-testid="wb-composer-input"]').fill("");

  out.shot = await shot(page, ".verify/retry.png");
} catch (error) {
  out.error = `在「${out.step ?? "未知"}」这一步失败：${String(error).split(String.fromCharCode(10))[0]}`;
} finally {
  /*
   * ⚠️ **异常路径也要收尾**（2026-10-16 自查逮到）：原来只有正常路径 `close()` + `killTree()`，
   * 抛异常时脚本会带着一个**活着的应用**退到 catch 里 —— 而"认领只认自己标记"的清理
   * （见 `harness` 那段补正）**不会再自动收走它**，于是它会变成孤儿：
   * 脚本被判成"超时"（跑不完）、机器上多一个 Electron。
   */
  await browser?.close().catch(() => undefined);
  if (booted?.child) await killTree(booted.child);
}

console.log(JSON.stringify(out, null, 2));

if (out.error) bad.push("异常：" + out.error);

/* ① 失败说得清 */
const failureText = (out.afterFailure ?? []).find((t) => t.includes("出错了")) ?? "";
if (!failureText) bad.push("发出去之后界面里没有出现「出错了」—— 失败没有任何交代");
else if (failureText.replace("（出错了）", "").trim().length < 6) {
  bad.push(`失败只说了「出错了」没说原因（正文：${JSON.stringify(failureText)}）`);
} else if (!/连不上|超时|限流|密钥|余额|模型|拒绝/.test(failureText)) {
  bad.push(`失败的原因不像人话（正文：${JSON.stringify(failureText)}）—— 用户不知道下一步怎么办`);
}

/* ② 失败有出路 */
if (!(out.retryIds ?? []).length) bad.push("失败的那一步没有「重新生成」—— 出了错只能自己重打一遍");

/* ③ 重试是同一问的重跑 */
if ((out.userBubblesAfterFailure ?? []).length !== 1) {
  bad.push(`第一次失败之后用户提问就不是一句了（${JSON.stringify(out.userBubblesAfterFailure)}）—— 前置不成立`);
}
const usersNow = out.userBubblesAfterRetry ?? [];
if (usersNow.length !== 1) {
  bad.push(
    `重试之后用户提问变成 ${usersNow.length} 句（${JSON.stringify(usersNow)}）—— 「撤旧问答重发」这一半没做，模型会以为他在追问`,
  );
}
if (!(out.afterRetry ?? []).some((t) => t.includes("出错了"))) bad.push("重试之后没有再次失败落定 —— 这一轮的去向不明");

/* ④ 不卡忙碌态 */
if (out.stopAfterRetry) bad.push("失败之后还挂着停止键 —— 界面卡在「忙碌」态");
if (!out.sendEnabledAfterTyping) bad.push("失败之后输入框打上字、发送键还是不可用 —— 卡住了");

if (bad.length) {
  console.error("✗ " + bad.join("；"));
  process.exitCode = 1;
} else {
  console.log("✓ 失败之后有出路：说清了原因 / 那一步带「重新生成」/ 重试是同一问的重跑（提问只有一句）/ 不卡忙碌态");
}
