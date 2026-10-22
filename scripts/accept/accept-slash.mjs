// B2 验收：`/` 斜杠命令（本地 UI，不调模型）。
//
// 判据：
//   ① 行首 `/` 弹菜单，10 条命令都在；
//   ② `/co` 只剩 compact / context / cost；
//   ③ 未知命令按 Enter 不发出去，提示 /help；
//   ④ `/help` 真的执行（输入框清空 + 提示条出现）。
import { chromium } from "playwright";
import { openApp, expandComposerMore, sleep, killLeftovers, freshDir, pickPort } from "./harness.mjs";

const bad = [];
let count = 0;

async function step(name, fn) {
  count += 1;
  try {
    const detail = await fn();
    console.log(`   ✓ ${name}${detail ? "  —— " + detail : ""}`);
  } catch (error) {
    const msg = String(error?.message ?? error)
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .slice(0, 3)
      .join(" ⏐ ")
      .slice(0, 240);
    bad.push(`${name}（${msg}）`);
    console.log(`   ✗ ${name}  —— ${msg}`);
  }
}

await killLeftovers();
await freshDir(".verify/accept-slash-data");
const port = await pickPort([9961]);
const { browser, page, getLog } = await openApp(chromium, {
  port,
  dataDir: ".verify/accept-slash-data",
  cwd: ".",
});
await sleep(2200);
/* 首页的高级 chip 收在「更多」后面（脚本后面要点其中几颗） */
await expandComposerMore(page);
const input = page.locator('[data-testid="wb-composer-input"]');

await step("⭐ 输入 / 出命令菜单，10 条都在", async () => {
  await input.click();
  await input.fill("/");
  await sleep(350);
  if (!(await page.locator('[data-testid="wb-slash-menu"]').count())) throw new Error("菜单没出现");
  const names = ["new", "model", "plan", "compact", "context", "init", "export", "cost", "permissions", "map", "help"];
  for (const name of names) {
    if (!(await page.locator(`[data-testid="wb-slash-${name}"]`).count())) throw new Error(`缺少 /${name}`);
  }
  return names.length + " 条";
});

await step("输入 /co → 只剩 compact / context / cost", async () => {
  await input.fill("/co");
  await sleep(350);
  const visible = await page.locator('[data-testid^="wb-slash-"]').evaluateAll((els) =>
    els.map((e) => e.getAttribute("data-testid")).filter((v) => v && !v.includes("menu") && !v.includes("empty")),
  );
  const expected = ["wb-slash-compact", "wb-slash-context", "wb-slash-cost"];
  if (JSON.stringify(visible.sort()) !== JSON.stringify(expected.sort())) {
    throw new Error(`实际 ${JSON.stringify(visible)}`);
  }
  return visible.join(", ");
});

await step("⭐ 未知命令：提示 /help，正文保留不发送", async () => {
  await input.fill("/nope");
  await sleep(350);
  await input.press("Enter");
  await sleep(300);
  const note = page.locator('[data-testid="wb-material-note"]');
  if (!(await note.count())) throw new Error("没有提示条");
  const text = await note.innerText();
  if (!text.includes("/help")) throw new Error(`提示是 ${JSON.stringify(text)}`);
  const value = await input.inputValue();
  if (value !== "/nope") throw new Error(`正文被改成了 ${JSON.stringify(value)}`);
  return text.slice(0, 40);
});

await step("/help 执行后输入框清空", async () => {
  await input.fill("/help");
  await sleep(350);
  await input.press("Enter");
  await sleep(400);
  const value = await input.inputValue();
  if (value !== "") throw new Error(`输入框还是 ${JSON.stringify(value)}`);
  return "已执行";
});

await step("E1：/map 给出仓库地图摘要", async () => {
  await input.fill("/map");
  await sleep(300);
  await input.press("Enter");
  const note = page.locator('[data-testid="wb-material-note"]').last();
  let text = "";
  for (let i = 0; i < 30; i += 1) {
    await sleep(500);
    if (!(await note.count())) continue;
    text = await note.innerText();
    if (text.includes("仓库地图") || text.includes("还没有可索引")) break;
  }
  if (!text.includes("仓库地图")) throw new Error(`提示是 ${JSON.stringify(text)}`);
  return text.slice(0, 60);
});

await step("B4：Ctrl+L 打开模型菜单", async () => {
  await input.click();
  await input.press("Control+l");
  await sleep(350);
  if (!(await page.locator('[data-testid="wb-model-pop"]').count())) throw new Error("模型菜单没打开");
  await input.press("Control+l");
  await sleep(250);
  if (await page.locator('[data-testid="wb-model-pop"]').count()) throw new Error("再按一次没关掉");
  return "开/关都生效";
});

await step("C1：Shift+Tab 切换计划模式", async () => {
  await input.fill("");
  await input.click();
  await input.press("Shift+Tab");
  await sleep(300);
  if (!(await page.locator('[data-testid="wb-plan-banner"]').count())) throw new Error("计划提示条没出现");
  /* 2026-10-22：计划挪进「＋」菜单 —— 状态从菜单项的 aria-checked 读 */
  await page.locator('[data-testid="wb-composer-add"]').click();
  await sleep(250);
  const pressed = await page.locator('[data-testid="wb-add-plan"]').getAttribute("aria-checked");
  await page.keyboard.press("Escape");
  await sleep(200);
  if (pressed !== "true") throw new Error(`计划模式项 aria-checked=${pressed}`);
  await input.click();
  await input.press("Shift+Tab");
  await sleep(250);
  if (await page.locator('[data-testid="wb-plan-banner"]').count()) throw new Error("再按一次没退出");
  return "开/关都生效";
});

if (bad.length) {
  console.log(`\nB2 验收失败 ${bad.length}/${count}：`);
  for (const item of bad) console.log(`  - ${item}`);
  console.log("启动日志（尾部）：\n" + getLog().split("\n").slice(-20).join("\n"));
} else {
  console.log(`\nB2 验收通过（${count}/${count}）`);
}

await browser.close();
await killLeftovers();
process.exit(bad.length ? 1 : 0);
