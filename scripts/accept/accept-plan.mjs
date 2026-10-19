// C1 验收：计划模式的开关（本地 UI，不调模型）。
//
// 工具面本身（计划模式下 `write_file`/`run_command` 不下发）由
// `engine/runtime/planMode.test.ts` 的 `planToolNames` 断言；
// 这条验收问的是"用户点得到、状态看得见、进得去出得来"。
import { chromium } from "playwright";
import { openApp, sleep, killLeftovers, freshDir, pickPort } from "./harness.mjs";

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
await freshDir(".verify/accept-plan-data");
const port = await pickPort([10031]);
const { browser, page, getLog } = await openApp(chromium, {
  port,
  dataDir: ".verify/accept-plan-data",
  cwd: ".",
});
await sleep(2200);
const input = page.locator('[data-testid="wb-composer-input"]');
const chip = page.locator('[data-testid="wb-plan-toggle"]');
const banner = page.locator('[data-testid="wb-plan-banner"]');

const pressed = async () => (await chip.getAttribute("aria-pressed")) === "true";

await step("计划 chip 存在且初始关闭", async () => {
  if (!(await chip.count())) throw new Error("没有 wb-plan-toggle");
  if (await pressed()) throw new Error("初始就是开着的");
  return "初始 idle";
});

await step("⭐ 点 chip → 计划模式打开，提示条出现", async () => {
  await chip.click();
  await sleep(300);
  if (!(await pressed())) throw new Error("aria-pressed 还是 false");
  if (!(await banner.count())) throw new Error("提示条没出现");
  return "已进入计划模式";
});

await step("再点 chip → 退出，提示条消失", async () => {
  await chip.click();
  await sleep(300);
  if (await pressed()) throw new Error("还是开着");
  if (await banner.count()) throw new Error("提示条还在");
  return "已退出";
});

await step("Shift+Tab 与 chip 是同一个开关", async () => {
  await input.click();
  await input.press("Shift+Tab");
  await sleep(300);
  if (!(await pressed())) throw new Error("Shift+Tab 没打开");
  await input.press("Shift+Tab");
  await sleep(300);
  if (await pressed()) throw new Error("Shift+Tab 没关掉");
  return "两种入口一致";
});

await step("C2：上下文压力条在输入区右侧（未登记模型标窗口未知）", async () => {
  const meter = page.locator('[data-testid="wb-context-meter"]');
  if (!(await meter.count())) throw new Error("没有 wb-context-meter");
  const text = await meter.innerText();
  if (!text.includes("20k")) throw new Error(`分母不是保守默认 20k：${text}`);
  if (!text.includes("估算")) throw new Error(`来源没标估算：${text}`);
  return text.split("\n").join(" ");
});

await step("C3：模型菜单带搜索框", async () => {
  await input.click();
  await input.press("Control+l");
  await sleep(350);
  const search = page.locator('[data-testid="wb-model-search"]');
  if (!(await search.count())) throw new Error("没有 wb-model-search");
  await search.fill("co");
  await sleep(200);
  if ((await search.inputValue()) !== "co") throw new Error("搜索框不接受输入");
  await input.press("Control+l");
  await sleep(200);
  return "搜索框可用";
});

await step("D2：工具面板列出注册表里的工具与元数据", async () => {
  await page.locator('[data-testid="wb-nav-tools"]').click();
  await sleep(700);
  const rows = await page.locator('[data-testid^="wb-tool-"]').count();
  if (rows < 10) throw new Error(`只有 ${rows} 行`);
  const text = await page.locator('[data-testid="wb-tools-list"]').innerText();
  if (text.includes("未知")) throw new Error("有工具元数据是未知");
  return `${rows} 行`;
});

await step("F4：终端面板只读空态", async () => {
  await page.locator('[data-testid="wb-nav-terminal"]').click();
  await sleep(500);
  const empty = page.locator('[data-testid="wb-terminal-empty"]');
  const list = page.locator('[data-testid="wb-terminal-list"]');
  if (!(await list.count())) throw new Error("没有终端列表");
  if (await empty.count()) {
    const text = await empty.innerText();
    if (!text.includes("还没有命令")) throw new Error(text);
  }
  if (await page.locator('[data-testid="wb-terminal-input"]').count()) throw new Error("终端面板不该有输入框");
  return "只读回放（无输入框）";
});

await step("/plan 命令也切同一个开关", async () => {
  await page.locator('[data-testid="wb-nav-home"]').click();
  await sleep(600);
  await input.fill("/plan");
  await sleep(300);
  await input.press("Enter");
  await sleep(350);
  if (!(await pressed())) throw new Error("/plan 没打开");
  return "已打开";
});

if (bad.length) {
  console.log(`\nC1 验收失败 ${bad.length}/${count}：`);
  for (const item of bad) console.log(`  - ${item}`);
  console.log("启动日志（尾部）：\n" + getLog().split("\n").slice(-20).join("\n"));
} else {
  console.log(`\nC1 验收通过（${count}/${count}）`);
}

await browser.close();
await killLeftovers();
process.exit(bad.length ? 1 : 0);
