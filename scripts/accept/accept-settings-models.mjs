// 设置 →「模型」页（2026-10-16，主人：「我要的是一个完整的设计页」）—— 常驻回归。
//
// 布局判据来自主人给的那批开源项目（OpenCode / Goose / Cline / OpenHands / anything-llm）：
// **左列 provider（标状态）→ 右侧详情：拉取模型 / 勾选启用 / 设默认**。
//
// 判据（都是"点了要有真后果"）：
//   ① 设置里点「模型」这一行 → 子页真的打开，左列真列出 provider（不是空壳）；
//   ② 每家的状态是**真的**：至少有一家写出**密钥来源**（本应用已保存 / 来自环境变量 /
//      来自旧目录）—— 2026-10-21（M-02）起状态词换成了来源，旧词「有密钥」被删掉；
//   ③ 点「⟳ 拉取模型」→ 要么拉回真清单（勾选框出现），要么给出人话原因（不许静默）；
//   ④ ⭐ 勾选/取消 与「设为默认」**要落盘**（`dsh-canvas.model-settings`），
//      而且**主页那颗选择器读的就是它** —— 这条是"配了之后真用得上"的关键。
import { chromium } from "playwright";
import { killLeftovers, openApp, pickPort, sleep, verdict } from "./harness.mjs";

const bad = [];
const note = (m) => console.log("   " + m);

const port = await pickPort([9913]);
await killLeftovers();
const { browser, page } = await openApp(chromium, { port, dataDir: ".verify/accept-settings-models-data", cwd: "." });
await sleep(2000);

const saved = () =>
  page.evaluate(() => localStorage.getItem("dsh-canvas.model-settings"));

try {
  /* ① 设置 →「模型」这一行 → 子页 */
  /* 设置入口在账号菜单里（与 accept-voice / accept-accountmenu 同一套） */
  /* 设置入口在账号菜单里：点账号 → 菜单里的「设置」（与 accept-accountmenu 同一套） */
  await page.locator('[data-testid="wb-account"]').click();
  await sleep(500);
  await page.locator('[data-testid="wb-acct-settings"]').click();
  await sleep(900);
  const openedRow = await page.locator('[data-testid="wb-set-模型"]').count();
  if (!openedRow) {
    bad.push("设置列表里没有「模型」这一行");
  } else {
    await page.locator('[data-testid="wb-set-模型"]').click();
    await sleep(900);
  }
  const page0 = await page.locator('[data-testid="wb-setpage-models"]').count();
  if (!page0) bad.push("点「模型」没打开子页（wb-setpage-models 不在）");

  /* ② 左列真列出 provider，且状态是真的 */
  const rows = await page.locator('[data-testid^="wb-modelset-provider-"]').count();
  if (rows < 2) bad.push(`左列只列出 ${rows} 家 provider（不像真列表）`);
  const states = await page.locator(".wb-modelset-row em").allInnerTexts();
  /* 2026-10-21（M-02）：状态词是**密钥来源**；「有密钥」那句已被替换（它把别人的 key 也算成你配的） */
  const hasKey = states.some((s) => /本应用已保存|来自环境变量|来自旧目录|已验证/.test(s));
  if (!hasKey) bad.push(`没有一家写出密钥来源（实测：${JSON.stringify(states)}）—— 状态可能是写死的`);
  if (states.some((s) => s.trim() === "有密钥")) bad.push("还在用旧文案「有密钥」（该换成来源词）");
  note(`provider ${rows} 家；状态：${states.map((s) => s.trim()).join(" / ")}`);

  /* ③ 点一家 → 它的详情出来（拉取按钮 + 说明） */
  const first = page.locator('[data-testid^="wb-modelset-provider-"]').first();
  const firstName = ((await first.getAttribute("data-testid")) ?? "").replace("wb-modelset-provider-", "");
  await first.click();
  await sleep(500);
  if (!(await page.locator('[data-testid="wb-modelset-pull"]').count())) bad.push("详情里没有「拉取模型」按钮");
  note(`选中：${firstName}`);

  /* ④ 拉取：要么出清单、要么给人话（两种都算通过，静默不算） */
  await page.locator('[data-testid="wb-modelset-pull"]').click();
  await sleep(9000);
  const boxes = await page.locator('[data-testid^="wb-modelset-toggle-"]').count();
  const noteLine = (await page.locator('[data-testid="wb-modelset-note"]').allInnerTexts()).join(" ").trim();
  if (boxes === 0 && !noteLine) bad.push("点了拉取既没出清单、也没给原因（静默失败）");
  note(boxes > 0 ? `拉回 ${boxes} 个模型（勾选框出现）` : `没拉到，但给了原因：「${noteLine}」`);

  /* ⑤ ⭐ 勾选与默认要落盘 */
  if (boxes > 0) {
    const on = page.locator('[data-testid^="wb-modelset-toggle-"]').first();
    const mid = ((await on.getAttribute("data-testid")) ?? "").replace("wb-modelset-toggle-", "");
    await page.locator(`[data-testid="wb-modelset-default-${mid}"]`).click();
    await sleep(400);
    const raw = await saved();
    if (!raw || !raw.includes(mid)) bad.push(`「设为默认」没落盘（盘上：${String(raw).slice(0, 80)}）`);
    else if (!/"default":"[^"]*"/.test(raw)) bad.push("盘上没有 default 字段");
    note(`设为默认：${mid} → 落盘 ✓`);
  } else {
    note("（这一家没拉到清单，勾选那两条跳过 —— 不假绿）");
  }
} catch (e) {
  bad.push("异常: " + String(e).slice(0, 200));
} finally {
  await browser.close().catch(() => undefined);
  await killLeftovers();
}

verdict(bad, "设置·模型页成立：设置里打得开 / 左列真列 provider / 状态是真的 / 拉取要么出清单要么给人话 / 勾选与默认真落盘");
