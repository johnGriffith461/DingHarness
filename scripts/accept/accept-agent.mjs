import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";
import { bootApp, freshDir, killTree, shot } from "./harness.mjs";

/**
 * 验收：**创建 AI 智能体**（§156，对应 `chat/bot/create`）。
 *
 * ## 这条**不调模型**（进批跑）
 *
 * 五条断言：
 * ① 入口（输入区 `+` → 创建 AI 智能体）真能进
 * ② 文案与四组标签**与本体逐字一致**（`docs/evidence-bot.txt`）
 * ③ 校验：名称/描述没填时**说清缺什么**，不偷偷建一个空智能体
 * ④ 填完点「开始聊天」→ 落到 `agents.json`，**重开还在**
 * ⑤ 建出来的智能体**是"正在使用"**的（人设要能真的用上；真调模型的那条另见 accept-agent-persona）
 */
const DATA = "D:/DoubaoWorkClone/.verify/agent-data";
if (!(await freshDir(DATA))) {
  console.error("✗ 数据目录 " + DATA + " 删不掉 —— 先手工关掉占着它的 Electron");
  process.exit(1);
}
fs.mkdirSync(DATA, { recursive: true });

const PORT = 9305;
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

/**
 * 读 agents.json。
 *
 * ⚠️ 形状是 `{ agents, selected }` —— `selected` 也在里面。
 * 它原本放在 localStorage，但**那个是延迟落盘的**：强杀进程时会丢
 * （§156 就是这么发现的）。凡是跨重启要活下来的状态都走主进程落盘。
 */
const readFile = () => {
  const f = path.join(DATA, "agents.json");
  try {
    return JSON.parse(fs.readFileSync(f, "utf8"));
  } catch {
    return null;
  }
};
const readAgents = () => readFile()?.agents ?? null;

try {
  if (!(await boot())) {
    console.error("[诊断] 应用输出尾部：\n" + (getLog() || "(空)").slice(-1200));
    await killTree(child);
    process.exit(1);
  }

  let b = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
  let ctx = b.contexts()[0];
  let page = ctx.pages()[0] ?? (await ctx.waitForEvent("page"));
  await page.waitForSelector('[data-testid="wb"]', { timeout: 20000 });

  /* ── ① 入口 ── */
  await page.locator('[data-testid="wb-nav-home"]').click();
  await page.waitForTimeout(600);
  await page.locator('[data-testid="wb-composer-add"]').click();
  await page.waitForTimeout(300);
  out.menuHasAgent = await page.evaluate(
    () => document.querySelector('[data-testid="wb-add-pop"]')?.textContent?.includes("创建 AI 智能体") ?? false,
  );
  await page.locator('[data-testid="wb-add-agent"]').click();
  await page.waitForTimeout(1000);
  out.opened = (await page.locator('[data-testid="wb-agent"]').count()) > 0;
  out.panelTitle = await page.evaluate(() => document.querySelector(".wb-agent-head h2")?.textContent?.trim() ?? "");

  /* ── ② 文案与标签 ── */
  out.namePlaceholder = await page.evaluate(
    () => document.querySelector('[data-testid="wb-agent-name"]')?.getAttribute("placeholder") ?? "",
  );
  out.descPlaceholder = await page.evaluate(
    () => document.querySelector('[data-testid="wb-agent-desc"]')?.getAttribute("placeholder") ?? "",
  );
  out.groupTitles = await page.evaluate(() =>
    Array.from(document.querySelectorAll(".wb-agent-group-title")).map((e) => (e.textContent ?? "").trim()),
  );
  out.backgroundTags = await page.evaluate(() =>
    Array.from(document.querySelectorAll('[data-testid^="wb-agent-tag-background-"]')).map((e) =>
      (e.textContent ?? "").trim(),
    ),
  );

  /* ── ③ 校验：什么都不填就点「开始聊天」 ── */
  await page.locator('[data-testid="wb-agent-start"]').click();
  await page.waitForTimeout(400);
  out.errorEmptyName = await page.evaluate(
    () => document.querySelector('[data-testid="wb-agent-error"]')?.textContent?.trim() ?? "",
  );
  out.diskAfterInvalid = readAgents();

  /* 只填名称再点 */
  await page.locator('[data-testid="wb-agent-name"]').fill("英老师");
  await page.locator('[data-testid="wb-agent-start"]').click();
  await page.waitForTimeout(400);
  out.errorEmptyDesc = await page.evaluate(
    () => document.querySelector('[data-testid="wb-agent-error"]')?.textContent?.trim() ?? "",
  );

  /* ── ④ 填完建立 ── */
  await page.locator('[data-testid="wb-agent-tag-background-老师"]').click();
  await page.locator('[data-testid="wb-agent-tag-characteristic-温和"]').click();
  await page.locator('[data-testid="wb-agent-tag-hobby-书籍"]').click();
  await page.locator('[data-testid="wb-agent-tag-setting-在咖啡馆"]').click();
  await page.locator('[data-testid="wb-agent-desc"]').fill("你是一位经验丰富的英语老师，说话温和。");
  await page.locator('[data-testid="wb-agent-start"]').click();
  await page.waitForTimeout(1200);
  const onDisk = readAgents();
  out.diskCount = Array.isArray(onDisk) ? onDisk.length : -1;
  out.diskAgent = onDisk?.[0]
    ? {
        name: onDisk[0].name,
        desc: onDisk[0].description,
        background: onDisk[0].background,
        characteristic: onDisk[0].characteristic,
        hobby: onDisk[0].hobby,
        setting: onDisk[0].setting,
      }
    : null;
  out.viewAfterStart = await page.evaluate(
    () => (document.querySelector('[data-testid="wb-composer"]') ? "home" : "other"),
  );
  // 探针：刚建完就读一次 —— 分清"没写进去"与"写完被清掉"
  out.selectionJustCreated = await page.evaluate(() => localStorage.getItem("dsh-canvas.selected-agent"));
  out.allStorageKeys = await page.evaluate(() => Object.keys(localStorage));
  out.shot = await shot(page, "agent.png");
  await b.close();

  /* ── ④b 重启：智能体还在，且是"正在使用"的 ── */
  await killTree(child);
  await new Promise((r) => setTimeout(r, 1500));
  if (!(await boot())) {
    out.error = "重启失败：" + (getLog() || "(空)").slice(-300);
  } else {
    b = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
    ctx = b.contexts()[0];
    page = ctx.pages()[0] ?? (await ctx.waitForEvent("page"));
    await page.waitForSelector('[data-testid="wb"]', { timeout: 20000 });
    await page.locator('[data-testid="wb-composer-add"]').click();
    await page.waitForTimeout(300);
    await page.locator('[data-testid="wb-add-agent"]').click();
    await page.waitForTimeout(1200);
    out.afterRestartItems = await page.locator('[data-testid^="wb-agent-pick-"]').count();
    // 探针：选择到底有没有存下来（存了没恢复 ≠ 没存）
    // 选择现在存在主进程的 agents.json 里，不再看 localStorage
    out.storedSelection = readFile()?.selected ?? "";
    out.agentIdsOnDisk = (readAgents() ?? []).map((a) => a.id);
    out.selectedOnDisk = readFile()?.selected ?? "";
    out.afterRestartSelected = await page.evaluate(
      () => document.querySelector('[data-testid^="wb-agent-selected-"]')?.textContent?.trim() ?? "",
    );
    out.afterRestartLabel = await page.evaluate(
      () => document.querySelector('[data-testid^="wb-agent-pick-"]')?.textContent?.trim() ?? "",
    );
    await b.close();
  }
} catch (e) {
  out.error = String(e).slice(0, 300);
} finally {
  console.log(JSON.stringify(out, null, 2));
  await killTree(child);

  const bad = [];
  if (out.error) bad.push("异常: " + out.error);

  if (!out.menuHasAgent) bad.push("+ 菜单里没有「创建 AI 智能体」");
  if (!out.opened) bad.push("点入口没进表单");
  if (out.panelTitle !== "创建 AI 智能体") bad.push(`标题与本体不符：${out.panelTitle}`);
  if (out.namePlaceholder !== "输入名称") bad.push(`名称占位与本体不符：${out.namePlaceholder}`);
  if (!(out.descPlaceholder ?? "").includes("你是一位经验丰富的英语老师")) {
    bad.push(`设定描述占位与本体不符：${out.descPlaceholder}`);
  }
  if (JSON.stringify(out.groupTitles) !== JSON.stringify(["背景", "特征", "兴趣嗜好", "场景设定"])) {
    bad.push(`四组标题与本体不符：${JSON.stringify(out.groupTitles)}`);
  }
  if (JSON.stringify(out.backgroundTags) !== JSON.stringify(["CEO", "医生", "老师", "图书馆员", "运动员", "超级巨星"])) {
    bad.push(`背景标签与本体不符：${JSON.stringify(out.backgroundTags)}`);
  }

  if (!(out.errorEmptyName ?? "").includes("名称")) bad.push(`空名称没报对：${out.errorEmptyName}`);
  if (!(out.errorEmptyDesc ?? "").includes("设定描述")) bad.push(`空描述没报对：${out.errorEmptyDesc}`);
  if (out.diskAfterInvalid !== null) bad.push("校验没过却已经把智能体写盘了");

  if (out.diskCount !== 1) bad.push(`磁盘上智能体数不对：${out.diskCount}`);
  if (out.diskAgent?.name !== "英老师") bad.push(`磁盘上的名称不对：${out.diskAgent?.name}`);
  if (!(out.diskAgent?.desc ?? "").includes("英语老师")) bad.push("磁盘上的设定描述没落进去");
  if (JSON.stringify(out.diskAgent?.background) !== JSON.stringify(["老师"])) {
    bad.push(`背景标签没落盘：${JSON.stringify(out.diskAgent?.background)}`);
  }
  if (JSON.stringify(out.diskAgent?.setting) !== JSON.stringify(["在咖啡馆"])) {
    bad.push(`场景标签没落盘：${JSON.stringify(out.diskAgent?.setting)}`);
  }
  if (out.viewAfterStart !== "home") bad.push("点「开始聊天」之后没回到对话");

  if (out.afterRestartItems !== 1) bad.push(`重开后智能体没恢复：${out.afterRestartItems}`);
  if (!(out.afterRestartSelected ?? "").includes("正在使用")) bad.push("重开后没恢复「正在使用」这个选择");
  if (!out.selectedOnDisk) bad.push("磁盘上没有记着「当前选中」是哪一个");
  if (!(out.afterRestartLabel ?? "").includes("英老师")) bad.push(`重开后列表项不对：${out.afterRestartLabel}`);

  if (bad.length) {
    console.error("✗ " + bad.join("；"));
    process.exitCode = 1;
  } else {
    console.log("✓ 创建 AI 智能体成立：入口 / 文案与标签逐字对齐 / 校验拦得住 / 落盘并可重开 / 选择能恢复");
  }
}
