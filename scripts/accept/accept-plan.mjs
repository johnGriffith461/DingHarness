// C1 验收：计划模式的开关（本地 UI，不调模型）。
//
// 工具面本身（计划模式下 `write_file`/`run_command` 不下发）由
// `engine/runtime/planMode.test.ts` 的 `planToolNames` 断言；
// 这条验收问的是"用户点得到、状态看得见、进得去出得来"。
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";
import { openApp, expandComposerMore, openSummary, sleep, killLeftovers, freshDir, pickPort } from "./harness.mjs";

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
/*
 * G1：预置一段「计划已生成、等批准」的任务（不花真钱、不依赖模型）。
 * 这样面板、编辑、批准、落盘这条链可以在验收里完整走一遍。
 */
const PLAN_TEXT = [
  "1. 目标：把计划面板与落盘接上",
  "2. 范围：src/workbench 与 electron/ipc",
  "3. 步骤：先渲染面板，再写盘",
  "4. 验证：accept-plan 全绿",
  "5. 风险：写盘失败时仍继续执行",
].join("\n");
const PLAN_MARK = "补充：验收标记 PLAN-ACCEPT";
fs.mkdirSync(".verify/accept-plan-data", { recursive: true });
fs.writeFileSync(
  path.join(".verify/accept-plan-data", "tasks.json"),
  JSON.stringify({
    __schema: 1,
    data: [
      {
        id: "t-plan",
        title: "计划验收",
        brief: "重构计划流程",
        createdAt: 1,
        stage: "done",
        startedAt: 1,
        finishedAt: 2,
        steps: [
          { id: "s1", role: "user", text: "重构计划流程", at: 1 },
          { id: "s2", role: "assistant", text: PLAN_TEXT, at: 2 },
        ],
        questions: [],
        questionIndex: 0,
        activity: "",
        artifacts: [],
        planState: "awaiting_approval",
        planText: PLAN_TEXT,
      },
    ],
  }),
  "utf8",
);
const planFile = path.resolve(".ding/plans/t-plan.md");
fs.rmSync(planFile, { force: true });
const port = await pickPort([10031]);
const { browser, page, getLog } = await openApp(chromium, {
  port,
  dataDir: ".verify/accept-plan-data",
  cwd: ".",
});
await sleep(2200);
/* C-01：计划 chip 收在首页的「更多」后面 */
await expandComposerMore(page);
const input = page.locator('[data-testid="wb-composer-input"]');
/*
 * 2026-10-22 主人：「计划 这个东西 放到 对话框的加号里面」——
 * 计划从工具条上的 chip 变成「＋」菜单里的一项（`wb-add-plan`），菜单点完就关。
 * 所以判据改成"打开 ＋ 菜单 → 点它 → 提示条出现"，状态用菜单项的 aria-checked 读。
 */
const banner = page.locator('[data-testid="wb-plan-banner"]');
/** 打开「＋」菜单（幂等：已经开着就不要点第二下，那会把它关掉）。 */
const openAdd = async () => {
  if (await page.locator('[data-testid="wb-add-pop"]').count()) return;
  await page.locator('[data-testid="wb-composer-add"]').click();
  await sleep(250);
};
/** 关掉「＋」菜单（幂等）。 */
const closeAdd = async () => {
  if (!(await page.locator('[data-testid="wb-add-pop"]').count())) return;
  await page.locator('[data-testid="wb-composer-input"]').click();
  await sleep(200);
};
/** 计划模式现在开着没有：从「＋」菜单里那一项的 aria-checked 读（读完关掉菜单）。 */
const pressed = async () => {
  await openAdd();
  const value = await page.locator('[data-testid="wb-add-plan"]').getAttribute("aria-checked");
  await closeAdd();
  return value === "true";
};

await step("「＋」菜单里有计划模式，初始关闭", async () => {
  await openAdd();
  if (!(await page.locator('[data-testid="wb-add-plan"]').count())) {
    await closeAdd();
    throw new Error("「＋」菜单里没有「计划模式」");
  }
  if (await pressed()) throw new Error("初始就是开着的");
  return "初始 idle";
});

await step("⭐ 点「计划模式」→ 计划模式打开，提示条出现", async () => {
  await openAdd();
  await page.locator('[data-testid="wb-add-plan"]').click();
  await sleep(350);
  if (!(await banner.count())) throw new Error("提示条没出现");
  if (!(await pressed())) throw new Error("aria-checked 还是 false");
  return "已进入计划模式";
});

await step("再点「计划模式」→ 退出，提示条消失", async () => {
  await openAdd();
  await page.locator('[data-testid="wb-add-plan"]').click();
  await sleep(350);
  if (await banner.count()) throw new Error("提示条还在");
  if (await pressed()) throw new Error("还是开着");
  return "已退出";
});

await step("Shift+Tab 与「＋」里那项是同一个开关", async () => {
  await input.click();
  await input.press("Shift+Tab");
  await sleep(300);
  if (!(await pressed())) throw new Error("Shift+Tab 没打开");
  await input.press("Shift+Tab");
  await sleep(300);
  if (await pressed()) throw new Error("Shift+Tab 没关掉");
  return "两种入口一致";
});

await step("C2：上下文压力条在输入区右侧（没跑过任务时如实说未记录/未选模型）", async () => {
  const meter = page.locator('[data-testid="wb-context-meter"]');
  if (!(await meter.count())) throw new Error("没有 wb-context-meter");
  const text = await meter.innerText();
  /*
   * P0-08 改了这条口径：没有 lastRoute、也没有钉住模型时，**不再拿 20k 假充模型窗口**。
   * T-07 又改了一次文案：首页在没钉模型时显示「未选择模型」（有钉住才显示
   * 「模型窗口 N token 可用」）。所以这里接受三种如实说法：
   *   · 自动选择（未记录）—— 旧口径；
   *   · 未选择模型 —— 现在首页的口径；
   *   · 20k + 估算 —— 钉了未登记模型时的保守口径。
   */
  const honestEmpty = text.includes("自动选择（未记录）") || text.includes("未选择模型");
  const unknownWindow = text.includes("20k") && text.includes("估算");
  if (!honestEmpty && !unknownWindow) throw new Error(`压力条既没有如实说未记录，也不是未知窗口：${text}`);
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

await step("D2：工具页（已从主导航移进设置）列出注册表里的工具与元数据", async () => {
  /* 2026-10-22 主人：工具页不该占主导航 → 搬进 设置·数据与统计·工具 */
  await page.locator('[data-testid="wb-account"]').click();
  await sleep(400);
  await page.locator('[data-testid="wb-acct-settings"]').click();
  await sleep(700);
  await page.locator('[data-testid="wb-set-工具"]').click();
  await sleep(900);
  const rows = await page.locator('[data-testid^="wb-tool-"]').count();
  if (rows < 10) throw new Error(`只有 ${rows} 行`);
  const text = await page.locator('[data-testid="wb-tools-list"]').innerText();
  if (text.includes("未知")) throw new Error("有工具元数据是未知");
  return `${rows} 行`;
});

await step("F4：终端面板只读空态（已从主导航移到右栏页签）", async () => {
  /* 2026-10-22 主人：终端该在右侧面板里 */
  await page.locator('[data-testid="wb-settings-close"]').click().catch(() => undefined);
  await sleep(500);
  await openSummary(page);
  await sleep(500);
  await page.locator('[data-testid="wb-summary-tab-terminal"]').click();
  await sleep(700);
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

await step("G1：预置的待批准计划 → 打开任务 → 右侧面板出现", async () => {
  await page.locator('[data-testid="wb-center-open"]').click();
  await sleep(500);
  await page.locator('[data-testid="wb-center-row-t-plan"] button').first().click();
  await sleep(500);
  const panel = page.locator('[data-testid="wb-plan-panel"]');
  if (!(await panel.count())) throw new Error("没有计划面板");
  if ((await panel.getAttribute("data-plan-state")) !== "awaiting_approval") {
    throw new Error(`面板状态不是 awaiting_approval：${await panel.getAttribute("data-plan-state")}`);
  }
  const input = page.locator('[data-testid="wb-plan-input"]');
  if ((await input.inputValue()) !== PLAN_TEXT) throw new Error("面板内容与计划文本不一致");
  return "面板可见、内容一致";
});

await step("G1：⭐ 改一行 → 开始执行 → 计划写入 .ding/plans/<id>.md", async () => {
  const input = page.locator('[data-testid="wb-plan-input"]');
  await input.fill(`${PLAN_TEXT}\n${PLAN_MARK}`);
  await page.locator('[data-testid="wb-plan-approve"]').click();
  /* 批准后会立刻发一轮"开始执行"（没有 provider 会失败，但不影响写盘） */
  await sleep(1500);
  if (!fs.existsSync(planFile)) throw new Error(`计划文件没写出来：${planFile}`);
  const written = fs.readFileSync(planFile, "utf8");
  if (!written.includes(PLAN_MARK)) throw new Error("落盘内容不是面板里编辑后的版本");
  const state = await page.locator('[data-testid="wb-plan-panel"]').getAttribute("data-plan-state");
  if (state !== "executing") throw new Error(`批准后状态是 ${state}`);
  return planFile;
});

await step("G1：执行态面板折叠成一行「计划已批准」", async () => {
  const panel = page.locator('[data-testid="wb-plan-panel"]');
  const text = await panel.innerText();
  if (!text.includes("计划已批准")) throw new Error(text.slice(0, 120));
  return "一行摘要";
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
/* 验收产物不留在仓库里（.ding 不是要提交的数据） */
try {
  fs.rmSync(planFile, { force: true });
} catch {
  /* 没写出来就不用删 */
}
process.exit(bad.length ? 1 : 0);
