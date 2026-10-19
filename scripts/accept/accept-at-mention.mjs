// B1 验收：`@` 引用菜单（文件 / 目录 / 会话 / 技能 / 动作）。
//
// 判据是**用户看到并操作到的结果**，不是"函数存在"：
//   ① 输入 `@` 出菜单，且文件分组里有 README.md；
//   ② 输入 `src` → 目录分组出现；
//   ③ 点一条文件 → 正文里出现 `@README.md`，并且出现引用 chip；
//   ④ 点 chip 的 × → 正文里的 token 与 chip 一起消失。
//
// 不调模型：只走本地 UI 与主进程读盘（DSH_NO_REAL_MODEL 在 CI 上兜底）。
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
await freshDir(".verify/accept-mentions-data");
const port = await pickPort([9951]);
const { browser, page, getLog } = await openApp(chromium, {
  port,
  dataDir: ".verify/accept-mentions-data",
  cwd: ".",
});
await sleep(2200);

const input = page.locator('[data-testid="wb-composer-input"]');

await step("首页输入区可用", async () => {
  if ((await input.count()) !== 1) throw new Error("没有找到 wb-composer-input");
});

await step("⭐ 输入 @ 出引用菜单，且文件分组里有 README.md", async () => {
  await input.click();
  await input.fill("@");
  /*
   * 2026-10-20：候选是**异步扫盘**的，固定 sleep(500) 会偶发红
   * （同一脚本两次跑一次有分组、一次没有）。改为等待条件。
   */
  const menu = page.locator('[data-testid="wb-phrase-menu"]');
  await menu.waitFor({ timeout: 8000 }).catch(() => undefined);
  if (!(await menu.count())) throw new Error("菜单没出现");
  const files = page.locator('[data-testid="wb-mention-group-file"]');
  await files.waitFor({ timeout: 8000 }).catch(() => undefined);
  if (!(await files.count())) throw new Error("没有文件分组");
  const readme = page.locator('[data-testid="wb-mention-file-README.md"]');
  await readme.waitFor({ timeout: 8000 }).catch(() => undefined);
  if (!(await readme.count())) throw new Error("文件分组里没有 README.md");
  return "菜单 / 文件分组 / README.md 都在";
});

await step("目录分组：输入 src 后出现目录候选", async () => {
  await input.fill("@src");
  const dirs = page.locator('[data-testid="wb-mention-group-dir"]');
  await dirs.waitFor({ timeout: 8000 }).catch(() => undefined);
  if (!(await dirs.count())) throw new Error("没有目录分组");
  return "目录分组出现";
});

await step("⭐ 点选文件 → 正文出现 @README.md，并有引用 chip", async () => {
  await input.fill("@README");
  const item = page.locator('[data-testid="wb-mention-file-README.md"]').first();
  await item.waitFor({ timeout: 8000 }).catch(() => undefined);
  if (!(await item.count())) throw new Error("没有 README.md 候选");
  await item.click();
  await sleep(300);
  const value = await input.inputValue();
  if (!value.includes("@README.md")) throw new Error(`正文是 ${JSON.stringify(value)}`);
  const chip = page.locator('[data-testid="wb-mention-chip-README.md"]');
  if (!(await chip.count())) throw new Error("没有引用 chip");
  return value;
});

await step("删掉正文里的引用 → chip 一起消失", async () => {
  await input.fill("没有引用了");
  await sleep(300);
  const chip = page.locator('[data-testid="wb-mention-chips"]');
  if (await chip.count()) throw new Error("chip 还在");
  return "chip 已移除";
});

await step("Esc 收起菜单", async () => {
  await input.fill("@");
  await sleep(400);
  if (!(await page.locator('[data-testid="wb-phrase-menu"]').count())) throw new Error("菜单没出现");
  await input.press("Escape");
  await sleep(250);
  if (await page.locator('[data-testid="wb-phrase-menu"]').count()) throw new Error("Esc 后菜单还在");
  return "Esc 可收起";
});

if (bad.length) {
  console.log(`\nB1 验收失败 ${bad.length}/${count}：`);
  for (const item of bad) console.log(`  - ${item}`);
  console.log("启动日志（尾部）：\n" + getLog().split("\n").slice(-20).join("\n"));
} else {
  console.log(`\nB1 验收通过（${count}/${count}）`);
}

await browser.close();
await killLeftovers();
process.exit(bad.length ? 1 : 0);
