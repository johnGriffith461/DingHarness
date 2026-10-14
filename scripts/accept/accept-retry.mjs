import { chromium } from "playwright";
import { spawn } from "node:child_process";
import fs from "node:fs";
import { connectWithRetry, openCanvas, pickPort, shot, verdict } from "./harness.mjs";

/**
 * 聊天失败后的「重试」（§187 界面体检 P1 点名的两处接线之一）。
 *
 * ## 这条为什么**不连模型**
 * 要验的是"失败之后能不能处置"，那就得先有一次失败。这里用
 * `DSH_CREDENTIALS_FILE` 指到一个**空文件**：应用里一个密钥都没有 →
 * 所有通道都是"无密钥" → 发送必然立刻失败（不发任何网络请求）。
 * 于是"失败"是**确定性的**：不依赖模型在不在、快不快、有没有配额。
 *
 * ## 断的是后果，不是"界面上有颗按钮"
 *   ① 失败后那张红字里**有**可点的「重试」（不是一行不可处置的通知）
 *   ② 点它之后：那条失败回复**和它对应的提问一起撤掉**，用同一段话重发
 *      —— 所以用户那句话**只出现一次**（撤少了会变两句：模型以为他追问了）
 *   ③ 重发是**新一轮**（消息 id 变了），不是"把红字藏起来当无事发生"
 *   ④ 这一轮的失败**至少说了原因**（不是空白红框）
 *
 * ⚠️ 界面上的"问了几遍"是真的会误导人的：`send` 每次都往历史里追加一条用户消息，
 * 所以"重试"如果只重发不撤，历史里就有两条一样的提问。
 */
const DATA = ".verify/retry-data";
fs.rmSync(DATA, { recursive: true, force: true });
/*
 * 凭据文件是 **YAML**（`electron/ipc/credentials.ts` 只解析 `refs:` 下一层的 KEY: value），
 * 不是 JSON —— 所以这里写一个**空的 refs 段**，而不是 `{}`。
 */
const EMPTY_KEYS = ".verify/retry-keys-empty.yaml";
fs.writeFileSync(EMPTY_KEYS, "refs:\n", "utf8");

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
env.DSH_CANVAS_DATA_DIR = DATA;
env.DSH_CREDENTIALS_FILE = EMPTY_KEYS;

/* 这台机器的回环端口会随机连不上（见 harness.pickPort）→ 起之前先挑一个能用的。 */
const __port = await pickPort([12740]);
const child = spawn(
  "node_modules/electron/dist/electron.exe",
  [".", "--remote-debugging-port=" + __port],
  { cwd: ".", env, stdio: ["ignore", "ignore", "ignore"] },
);
await new Promise((r) => setTimeout(r, 9000));

const browser = await connectWithRetry(chromium, "http://127.0.0.1:" + __port);
const ctx = browser.contexts()[0];
const pages = ctx.pages();
const page = pages.find((p) => !p.url().startsWith("devtools://")) ?? pages[0];
await page.waitForSelector('[data-testid="wb"]', { timeout: 20000 });
await page.waitForTimeout(2000);

const report = {};
try {
  report.step = "打开聊天";
  /*
   * 聊天侧栏在画布里，开关是 `wb-canvas-chat-toggle`（`Workbench.tsx:207`）：
   * 先开画布，再点它。没开画布就点 → 那个按钮根本不存在（会静默失败）。
   */
  if ((await page.locator('[data-testid="wb-canvas"]').count()) === 0) {
    await openCanvas(page);
    await page.waitForTimeout(2200);
  }
  if ((await page.locator('[data-testid="chat-input"]').count()) === 0) {
    await page.locator('[data-testid="wb-canvas-chat-toggle"]').click();
    await page.waitForTimeout(1500);
  }
  report.chatOpen = await page.locator('[data-testid="chat-input"]').count();

  /* 无密钥是这条脚本的前提：先如实记下来（前提不成立就该说清楚，而不是假绿）。 */
  report.providerNote = await page.evaluate(() =>
    [...document.querySelectorAll(".chat-provider select option")]
      .map((o) => o.textContent?.trim() ?? "")
      .filter((t) => t.includes("无密钥")).length,
  );

  /*
   * 「引用画布节点」那颗 @（`chat-ref-add`）—— 原来**没有任何脚本引用过它**
   * （§208 的零覆盖清单）。断后果：点它之后输入框里真的多出一个 `@`
   * （它就是靠这个把引用菜单唤出来的），而不是一颗摆着好看的按钮。
   */
  report.step = "点「引用画布节点」";
  await page.locator('[data-testid="chat-input"]').fill("");
  await page.locator('[data-testid="chat-ref-add"]').click();
  await page.waitForTimeout(500);
  report.afterRefAdd = await page.locator('[data-testid="chat-input"]').inputValue();
  /* 引用菜单应当被唤起（@ 之后紧跟空查询） */
  report.refMenuShown = await page.locator('[data-testid="chat-mentions"]').count();
  await page.locator('[data-testid="chat-input"]').fill("");

  report.step = "发一句话（注定失败）";
  const QUESTION = "帮我写一段不会成功的请求";
  await page.locator('[data-testid="chat-input"]').fill(QUESTION);
  await page.locator('[data-testid="chat-send"]').click();
  /* 等失败落定：既要红字出现，也要流已经停了（停止键没了）。 */
  await page.waitForSelector(".chat-msg.is-error", { timeout: 30000 });
  await page.waitForTimeout(800);

  report.questionsBefore = await page.$$eval(".chat-msg.user .chat-bubble", (els) =>
    els.map((e) => e.textContent.trim()),
  );
  report.errorText = await page.locator(".chat-msg.is-error .chat-msg-error").textContent().catch(() => null);
  const retryButtons = await page.$$eval('[data-testid^="chat-retry-"]', (els) =>
    els.map((e) => e.getAttribute("data-testid")),
  );
  report.retryButtons = retryButtons;
  report.firstRetryId = retryButtons[0]?.replace("chat-retry-", "") ?? null;

  report.step = "点重试";
  await page.locator(`[data-testid="${retryButtons[0]}"]`).click();
  /*
   * ⚠️ 必须等**这一轮真的收尾**再读：上面那句 `waitForSelector(".chat-msg.is-error")` 在
   * 点完重试的瞬间就已经成立（旧的那条红字还在），于是会读到"新一轮还没长出来"的中间态 ——
   * 第一版就是这么假红的（读到旧消息 id，判成"没重发"）。
   * 收尾的判据用**停止键消失**：它在流式期间才在。
   */
  await page.waitForFunction(() => !document.querySelector('[data-testid="chat-send-stop"]'), { timeout: 20000 });
  await page.waitForSelector(".chat-msg.is-error", { timeout: 20000 });
  await page.waitForTimeout(800);

  report.questionsAfter = await page.$$eval(".chat-msg.user .chat-bubble", (els) =>
    els.map((e) => e.textContent.trim()),
  );
  report.retryIdAfter = await page
    .$$eval('[data-testid^="chat-retry-"]', (els) => els[0]?.getAttribute("data-testid") ?? null)
    .catch(() => null);
  report.messageCountAfter = await page.locator(".chat-msg").count();
  report.errorTextAfter = await page.locator(".chat-msg.is-error .chat-msg-error").textContent().catch(() => null);
  /* 流真的停了：不该还挂着"停止" */
  report.stoppedAfterRetry = (await page.locator('[data-testid="chat-send-stop"]').count()) === 0;

  await shot(page, ".verify/retry.png");
} catch (error) {
  report.error = `在「${report.step ?? "未知"}」这一步失败：${String(error).split(String.fromCharCode(10))[0]}`;
} finally {
  console.log(JSON.stringify(report, null, 2));

  const bad = [];
  if (report.error) bad.push(`异常：${String(report.error).slice(0, 200)}`);
  if (!report.chatOpen) bad.push("聊天侧栏打不开");
  /* 前提：这条脚本靠"没有密钥 → 必然失败"成立。前提不成立就不是绿，是**没测到**。 */
  if (!report.providerNote) bad.push("前提不成立：没有看到「无密钥」的通道（这条脚本要靠它制造确定性失败）");

  const before = report.questionsBefore ?? [];
  const after = report.questionsAfter ?? [];

  /* ① 失败必须给出路 */
  if ((report.retryButtons?.length ?? 0) !== 1) {
    bad.push(`失败后有 ${report.retryButtons?.length ?? 0} 颗「重试」（应正好 1 颗）`);
  }
  /* ② 失败要说清原因 */
  if (!/[\u4e00-\u9fa5A-Za-z]/.test(report.errorText ?? "")) {
    bad.push(`失败那张红字没说什么原因：${JSON.stringify(report.errorText)}`);
  }

  /* ②b 引用按钮：点了输入框里真多一个 @，并把引用菜单唤出来 */
  if (report.afterRefAdd !== "@") bad.push(`点「引用画布节点」后输入框里是 ${JSON.stringify(report.afterRefAdd)}（应是一个 @）`);
  if (!report.refMenuShown) bad.push("打了 @ 却没有唤出引用菜单（那颗按钮等于装饰）");

  /* ③ 重试 = 撤掉失败那对 + 用同一段话重发 */
  if (before.length !== 1) bad.push(`发送后应该只有 1 条用户消息，实际 ${before.length} 条`);
  if (after.length !== 1) {
    bad.push(`⭐ 重试后用户消息变成 ${after.length} 条（应仍是 1 条 —— 撤掉旧提问再用同一段话重发）`);
  }
  if (before[0] && after[0] && before[0] !== after[0]) bad.push("重试把用户那句话改掉了");
  if (!after[0]?.includes("不会成功的请求")) bad.push(`重试后那句话不是原来的：${JSON.stringify(after[0])}`);

  /* ④ 是**新一轮**，不是把红字藏起来 */
  if (!report.retryIdAfter) bad.push("重试之后没有新的失败回复（那颗「重试」也不见了）");
  if (report.retryIdAfter === `chat-retry-${report.firstRetryId}`) {
    bad.push("⭐ 重试前后是同一条消息 id —— 这是把红字藏起来，不是重发");
  }
  /* ⑤ 这一轮也失败得说清原因，且流已经停了 */
  if (!/[\u4e00-\u9fa5A-Za-z]/.test(report.errorTextAfter ?? "")) {
    bad.push(`重发之后那次失败没说原因：${JSON.stringify(report.errorTextAfter)}`);
  }
  if (!report.stoppedAfterRetry) bad.push("重试之后「停止」键还挂着（那一轮没收尾）");

  verdict(bad, "聊天重试成立：失败有原因也有出路 / 点重试撤掉旧问答再用同一段话重发（话不重复、id 是新的）/ 流正常收尾");

  await browser.close().catch(() => undefined);
  child.kill();
  process.exit(process.exitCode ?? 0);
}
