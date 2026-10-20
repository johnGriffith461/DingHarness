import { chromium } from "playwright";
import { spawn } from "node:child_process";
import fs from "node:fs";
import { connectWithRetry, expandComposerMore, pickPort, shot, waitForPort, dismissFirstRunIfShown } from "./harness.mjs";

/**
 * 验收：输入区三个 chip（用户报的三个问题）。
 *
 *   ① 「本地电脑」**已删掉**（默认就是它，没有可选项时留着没用）
 *   ② 「项目」点了**要有下拉**（原来是没有 onClick 的死按钮）
 *   ③ 「按需确认」点了**要有下拉**
 *
 * 验的是**点了之后 DOM 里真出现了选项** —— 不是"按钮渲染出来没有"。
 * 死按钮恰恰是"渲染出来了、点了没反应"，所以只查存在性是查不出来的。
 */
const DATA = ".verify/chip-data";
fs.rmSync(DATA, { recursive: true, force: true });
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
env.DSH_CANVAS_DATA_DIR = DATA;

/* 这台机器的回环端口会随机连不上（见 harness.pickPort）→ 起之前先挑一个能用的。 */
const __port = await pickPort([12971]);
/* 应用只认这个环境变量（命令行那个在打包产物里会被忽略）—— 两处必须是同一个端口。 */
env.DSH_DEBUG_PORT = String(__port);
const child = spawn("node_modules/electron/dist/electron.exe", [".", "--remote-debugging-port=" + __port], {
  cwd: ".",
  env,
  stdio: ["ignore", "ignore", "ignore"],
});

const out = {};
/* 固定等 13 秒会在机器忙时不够（应用还没监听）→ 改成轮询端口：实测过的失败形态是 `ECONNREFUSED`（= 什么都没在听，不是端口坏）。 */
await waitForPort(__port, 40000);
try {
  const b = await connectWithRetry(chromium, "http://127.0.0.1:" + __port);
  const page = b.contexts()[0].pages().find((p) => !p.url().startsWith("devtools://"));
  await page.waitForSelector('[data-testid="wb"]', { timeout: 20000 });
  await dismissFirstRunIfShown(page);
  await page.waitForTimeout(2200);
  /* C-01：项目 / 插件收在首页的「更多」后面 */
  await expandComposerMore(page);

  // ① 环境 chip 应该没了
  out.envChipGone = (await page.locator('[data-testid="wb-env"]').count()) === 0;
  out.envTextStillThere = await page.evaluate(() =>
    [...document.querySelectorAll(".wb-composer-bar .wb-chip")].some((e) => (e.textContent ?? "").includes("本地电脑")),
  );
  out.chips = await page.evaluate(() =>
    [...document.querySelectorAll(".wb-composer-bar .wb-chip")].map((e) => (e.textContent ?? "").trim()),
  );

  // ② 项目 → 下拉
  await expandComposerMore(page);
  await page.locator('[data-testid="wb-project"]').click();
  await page.waitForTimeout(600);
  out.projectPopOpened = (await page.locator('[data-testid="wb-project-pop"]').count()) === 1;
  out.projectPopText = await page.evaluate(
    () => document.querySelector('[data-testid="wb-project-pop"]')?.textContent?.trim() ?? null,
  );

  // ③ 按需确认 → 下拉（先关掉项目那个）
  await page.locator('[data-testid="wb-project"]').click();
  await page.waitForTimeout(400);
  await page.locator('[data-testid="wb-confirm"]').click();
  await page.waitForTimeout(600);
  out.confirmPopOpened = (await page.locator('[data-testid="wb-confirm-pop"]').count()) === 1;
  out.confirmOptions = await page.evaluate(() =>
    [...document.querySelectorAll('[data-testid^="wb-confirm-option-"]')].map((e) => e.textContent?.trim() ?? ""),
  );
  await shot(page, ".verify/chips.png");

  // 真选一个，看 chip 上的字有没有跟着变（"能选"的证据）
  await page.locator('[data-testid="wb-confirm-option-每步确认"]').click();
  await page.waitForTimeout(500);
  out.confirmAfterPick = await page.evaluate(
    () => document.querySelector('[data-testid="wb-confirm"]')?.textContent?.trim() ?? null,
  );


  /*
   * 刷新后还记不记得（§143）。
   *
   * 原来那个 chip 是 `useState("全部允许")` —— **局部 state**：
   * 用户选了「每步确认」，离开再回来就变回「全部允许」。
   * 而审批闸门要靠这个选择做判定（它随请求过给主进程），所以"记不住"不只是体验问题。
   */
  await page.reload();
  await page.waitForSelector('[data-testid="wb"]', { timeout: 20000 });
  await dismissFirstRunIfShown(page);
  await page.waitForTimeout(2000);
  /* 刷新后首页回到紧凑态：后面的项目/插件/技能面板步骤要重新展开「更多」 */
  await expandComposerMore(page);
  out.confirmAfterReload = await page.evaluate(
    () => document.querySelector('[data-testid="wb-confirm"]')?.textContent?.trim() ?? null,
  );

  /* ── 「技能」命令面板：宽度与排版（2026-10-13 补） ──
   *
   * ⚠️ 这个面板**在此之前没有任何验收点过它**（`wb-skill-panel` 在 scripts/accept/ 里零命中），
   * 于是它烂了很久没人知道：面板宽高跟着**定位祖先**（`.wb-env`，只有 59px = 技能 chip 的宽），
   * 中文**一字一行**竖着排、还压在推荐卡上 —— 用户截图报上来的就是这个。
   * 断言量的是**排版结果**（宽 ≥ 240、首项高度 ≤ 60 即"一行放得下"），不是"元素在不在"。
   */
  await page.locator('[data-testid="wb-skills"]').click();
  await page.waitForTimeout(700);
  out.skillPanel = await page.evaluate(() => {
    const el = document.querySelector('[data-testid="wb-skill-panel"]');
    if (!el) return null;
    const first = el.querySelector('[data-testid^="wb-cmd-"]');
    return {
      width: Math.round(el.getBoundingClientRect().width),
      firstItemHeight: first ? Math.round(first.getBoundingClientRect().height) : null,
      hasSearch: Boolean(el.querySelector('[data-testid="wb-cmd-search"]')),
      items: el.querySelectorAll('[data-testid^="wb-cmd-"]').length,
    };
  });
  await shot(page, "chips-skillpanel.png");

  /*
   * ⚠️ 2026-10-13 补：`wb-rec-*`（面板里的「推荐」那一组）**原来没有任何脚本引用过**
   * （`src/` × `scripts/accept/` 交叉，见 HANDOFF §208 的零覆盖清单）——
   * 上面那条只数了 `wb-cmd-*`，推荐组是另一套 testid，一条都不在计数里。
   * 断**后果**：推荐组在、且**有条目**（`SUGGESTIONS` 是静态表，一条都没有就是坏了）。
   */
  out.recItems = await page.evaluate(() =>
    Array.from(document.querySelectorAll('[data-testid^="wb-rec-"]')).map((e) => (e.textContent ?? "").trim()),
  );
  out.recHead = await page.evaluate(
    () => document.querySelector('[data-testid="wb-skill-panel"] .wb-cmd-head')?.textContent?.trim() ?? "",
  );
  /*
   * ── 输入区 `＋` 菜单：附件那一条（2026-10-14）──
   *
   * 它原来写的是"附件：本机版还没接原生文件对话框"（一行灰字）。
   * 现在接上了 —— 复用的是云盘页「上传」那条 IPC（`drive:import`）：
   * 选中的文件进云盘，然后直接挂成这一轮的资料。
   *
   * ⚠️ **原生对话框本身自动化不了**（模态），所以这里只能断"入口在、不是假按钮"；
   * 它下游那段（导入结果 → 附着哪些）由 `src/workbench/materialImport.test.ts` 钉住。
   */
  await expandComposerMore(page);
  await page.locator('[data-testid="wb-composer-add"]').click();
  await page.waitForTimeout(500);
  out.addMenu = await page.evaluate(() => {
    const el = document.querySelector('[data-testid="wb-add-file"]');
    return el ? { label: el.textContent?.trim() ?? "", disabled: el.disabled } : null;
  });
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);
  /*
   * ⚠️ 上面按 Esc 关掉的是**技能面板** —— 而下面那段（命令区六条）正以"面板开着"为前提。
   * 我第一版把 ＋ 菜单这段插在它前面，Esc 顺手把面板关了，于是后面全红（找 `wb-cmd-技能管理` 超时）。
   * 所以这里把它重新打开。
   */
  await page.locator('[data-testid="wb-skills"]').click();
  await page.waitForTimeout(700);

  /*
   * ── 命令区那六条：**能不能点要逐条说清**（2026-10-14）──
   *
   * 原来六条全是死按钮（`onPick` 从来没接）：点了没反应，用户只会以为坏了。
   * 现在有后端的接上（选择项目 / 工作模式设置 / 技能管理 / 创建画布 / **反馈**），
   * 没后端的如实禁用并写明原因（只剩 **用量** —— 它的真归宿是 V5-3 的成本账本）。
   *
   * ⚠️ 2026-10-17（V5 开工前清尾 §2.4 #7）：「反馈」从"如实禁用"变成**真做** ——
   * 本机版的反馈通道 = 导出诊断包（`src/workbench/feedbackExport.ts` →
   * `electron/ipc/diagnostics.ts`，自检项复用 doctor）。下面那段就是它的行为级回归：
   * 点了要有提示条、提示条里要有**真实路径**、那个文件要**真的在盘上**。
   */
  out.commands = await page.evaluate(() =>
    Array.from(document.querySelectorAll('[data-testid^="wb-cmd-"]')).map((e) => ({
      label: (e.getAttribute("data-testid") ?? "").replace("wb-cmd-", ""),
      disabled: e.disabled,
      reason: e.getAttribute("title") ?? "",
    })),
  );
  /*
   * 反馈：点下去 → **先开诊断包预览**（G17）→ 确认后导出 → 文件真的写出来。
   *
   * ⚠️ 2026-10-18（G17）：这一条原来断言"点完立刻有提示条 + 文件已写盘"。
   * 行为是有意改的：用户对"要发给别人什么"要有过目机会，所以先预览再导出。
   * 判据跟着改成：预览里有内容（且**此时还没写盘**）→ 点导出 → 文件出现。
   */
  out.feedbackPreview = false;
  out.feedbackWroteBeforeExport = null;
  out.feedbackNote = null;
  out.feedbackFile = null;
  if (out.commands.some((c) => c.label === "反馈" && !c.disabled)) {
    await page.locator('[data-testid="wb-cmd-反馈"]').click();
    await page.waitForTimeout(1500);
    out.feedbackPreview = (await page.locator('[data-testid="wb-diagnostics-json"]').count()) > 0;
    const dirBefore = `${DATA}/diagnostics`;
    const before = fs.existsSync(dirBefore) ? fs.readdirSync(dirBefore).filter((f) => f.endsWith(".json")) : [];
    out.feedbackWroteBeforeExport = before.length > 0;
    if (out.feedbackPreview) {
      await page.locator('[data-testid="wb-diagnostics-export"]').click();
      for (let i = 0; i < 40; i += 1) {
        const now = fs.existsSync(dirBefore) ? fs.readdirSync(dirBefore).filter((f) => f.endsWith(".json")) : [];
        if (now.length) break;
        await page.waitForTimeout(250);
      }
      out.feedbackNote = (await page.locator('[data-testid="wb-diagnostics-result"]').textContent().catch(() => "")) ?? "";
      const dir = `${DATA}/diagnostics`;
      const files = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
      out.feedbackFile = files.find((f) => f.endsWith(".json")) ?? null;
      /* 关掉预览浮层（它盖着整页，不关后面点不到） */
      await page.keyboard.press("Escape");
      await page.waitForTimeout(700);
    }
    /* 点完一条命令面板会自己关（`onPick` 之后 onClose）—— 后面的「技能管理」要重新打开它 */
    await page.locator('[data-testid="wb-skills"]').click();
    await page.waitForTimeout(700);
  }
  /* 「技能管理」应当**直接落到插件页的管理子页**（不是先落市场） */
  await page.locator('[data-testid="wb-cmd-技能管理"]').click();
  await page.waitForTimeout(1200);
  out.afterManageCmd = await page.evaluate(() => ({
    managePage: document.querySelectorAll('[data-testid="wb-page-plugins-manage"]').length,
    crumb: document.querySelector(".wb-crumb")?.textContent?.trim() ?? "",
  }));
  /* 回到首页，再验「选择项目」——它该打开输入区那个项目 chip 的下拉 */
  await page.locator('[data-testid="wb-nav-home"]').click();
  await page.waitForTimeout(900);
  /* 回首页后 Composer 重新挂载：紧凑态，项目 chip 在「更多」后面 */
  await expandComposerMore(page);
  await page.locator('[data-testid="wb-skills"]').click();
  await page.waitForTimeout(600);
  await page.locator('[data-testid="wb-cmd-选择项目"]').click();
  await page.waitForTimeout(600);
  out.afterProjectCmd = await page.evaluate(
    () => document.querySelectorAll('[data-testid="wb-project-pop"]').length,
  );

  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);

  /*
   * ── 「插件」chip 的下拉（2026-10-13 补，见 §208 零覆盖清单）──
   *
   * 这条数据目录里没装任何插件，所以下拉里应当是**那句如实说明**（而不是空面板）。
   * `wb-plugin-toggle-*` 要有条目才出现 —— 那条属于"装了插件之后"的场景，没在这里补。
   */
  await page.locator('[data-testid="wb-plugins"]').click();
  await page.waitForTimeout(600);
  out.pluginPop = await page.evaluate(() => {
    const box = document.querySelector('[data-testid="wb-plugin-pop"]');
    return { count: box ? 1 : 0, text: box ? (box.textContent ?? "").trim() : "" };
  });
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);

  /*
   * ── 项目 chip 的选项与「不归入项目」（2026-10-13 补，见 §208 零覆盖清单）──
   *
   * `wb-project-option-*` / `wb-project-clear` 都没有脚本点过。要出现它们得先**有一个项目** ——
   * 所以在左栏现建一个（`wb-project-new` → 填名字 → Enter），再来点 chip：
   *   · 选中项目 → chip 上的字真的跟着变（"能选"的证据）；
   *   · 点「不归入项目」→ chip 回到「项目」（`wb-project-clear` 真能清）。
   */
  await page.locator('[data-testid="wb-project-new"]').click();
  await page.waitForTimeout(400);
  await page.locator('[data-testid="wb-project-name"]').fill("周报项目");
  await page.locator('[data-testid="wb-project-name"]').press("Enter");
  await page.waitForTimeout(900);
  await page.locator('[data-testid="wb-project"]').click();
  await page.waitForTimeout(500);
  out.projectOptions = await page.evaluate(() =>
    Array.from(document.querySelectorAll('[data-testid^="wb-project-option-"]')).map((e) => (e.textContent ?? "").trim()),
  );
  const firstProjectOption = await page.evaluate(
    () => document.querySelector('[data-testid^="wb-project-option-"]')?.getAttribute("data-testid") ?? "",
  );
  if (firstProjectOption) {
    await page.locator(`[data-testid="${firstProjectOption}"]`).click();
    await page.waitForTimeout(600);
  }
  out.projectChipAfterPick = await page.evaluate(
    () => document.querySelector('[data-testid="wb-project"]')?.textContent?.replace(/\s+/g, "") ?? "",
  );
  await page.locator('[data-testid="wb-project"]').click();
  await page.waitForTimeout(500);
  out.clearBtnShown = await page.locator('[data-testid="wb-project-clear"]').count();
  if (out.clearBtnShown) {
    await page.locator('[data-testid="wb-project-clear"]').click();
    await page.waitForTimeout(600);
  }
  out.projectChipAfterClear = await page.evaluate(
    () => document.querySelector('[data-testid="wb-project"]')?.textContent?.replace(/\s+/g, "") ?? "",
  );

  await b.close();
} catch (e) {
  out.error = String(e).slice(0, 220);
} finally {
  console.log(JSON.stringify(out, null, 2));
  child.kill();
  const bad = [];
  if (!out.envChipGone) bad.push("「本地电脑」chip 还在");
  if (!out.projectPopOpened) bad.push("「项目」没有下拉");
  if (!out.confirmPopOpened) bad.push("「按需确认」没有下拉");
  if (!(out.confirmAfterPick ?? "").includes("每步确认")) bad.push("选了没生效: " + out.confirmAfterPick);
  if (!(out.confirmAfterReload ?? "").includes("每步确认")) bad.push("档位刷新后没记住：" + out.confirmAfterReload);
  /* 技能面板：排版断言（不是"元素在不在"） */
  if (!out.skillPanel) bad.push("「技能」命令面板打不开（wb-skill-panel）");
  else {
    if (out.skillPanel.width < 240) bad.push(`⭐ 技能面板被挤成 ${out.skillPanel.width}px（中文会一字一行）`);
    if ((out.skillPanel.firstItemHeight ?? 0) > 60) {
      bad.push(`⭐ 技能面板首项高 ${out.skillPanel.firstItemHeight}px —— 说明文字竖排了（一行应当 ≤ 40px 上下）`);
    }
    if (!out.skillPanel.hasSearch) bad.push("技能面板底部没有搜索框");
    if (out.skillPanel.items < 3) bad.push(`技能面板条目太少（${out.skillPanel.items} 条）`);
  }

  /* 补的那组（零覆盖清单里的推荐组 / 插件下拉 / 项目选项与清除，§208） */
  if ((out.recItems ?? []).length < 1) bad.push("技能面板里没有「推荐」那一组（wb-rec-*）");
  else if (!(out.recHead ?? "").startsWith("推荐")) {
    bad.push(`推荐组的标题不对：${out.recHead}`);
  }
  if (out.pluginPop?.count !== 1) bad.push("「插件」chip 没有下拉（wb-plugin-pop）");
  else if (!out.pluginPop.text.includes("还没安装任何插件")) {
    bad.push(`没装插件时下拉该如实说明，实际文本：${JSON.stringify(out.pluginPop.text)}`);
  }
  if ((out.projectOptions ?? []).length < 1) bad.push("「项目」下拉里没有项目选项（wb-project-option-*）");
  if (!(out.projectChipAfterPick ?? "").includes("周报项目")) {
    bad.push(`选了项目之后 chip 上的字没跟着变：${out.projectChipAfterPick}`);
  }
  if (out.clearBtnShown !== 1) bad.push("选中项目后没有「不归入项目」（wb-project-clear）");
  if ((out.projectChipAfterClear ?? "").includes("周报项目")) {
    bad.push(`点了「不归入项目」chip 还挂着项目名：${out.projectChipAfterClear}`);
  }
  /* 命令区：六条都在，没后端的如实禁用且写明原因 */
  const cmds = out.commands ?? [];
  for (const need of ["选择项目", "用量", "工作模式设置", "技能管理", "反馈"]) {
    if (!cmds.some((c) => c.label === need)) bad.push(`命令区少了「${need}」`);
  }
  for (const c of cmds) {
    if (c.disabled && !c.reason) bad.push(`命令「${c.label}」禁用了却没写原因`);
  }
  if (!cmds.some((c) => c.label === "用量" && c.disabled && c.reason)) {
    bad.push("「用量」本该如实禁用并说明（本机版没有账号服务端）");
  }
  /*
   * 「反馈」2026-10-17 起是真能力（V5 开工前清尾 §2.4 #7）：点了要出提示条、
   * 提示条里要有真实路径、诊断包要真的写进数据目录。
   */
  if (!cmds.some((c) => c.label === "反馈" && !c.disabled)) {
    bad.push("⭐「反馈」本该能点（本机版反馈通道 = 导出诊断包）");
  }
  if (cmds.some((c) => c.label === "反馈" && !c.disabled)) {
    /* G17：先预览（此时不该写盘），确认后才导出 */
    if (!out.feedbackPreview) bad.push("点「反馈」没有打开诊断包预览（G17 起走预览再导出）");
    if (out.feedbackWroteBeforeExport) bad.push("预览阶段就已经写盘了 —— 用户还没来得及看内容");
    if (!out.feedbackFile) {
      bad.push("在预览里点「导出」之后，diagnostics/ 里没有诊断包文件");
    }
  }
  if (!cmds.some((c) => c.label === "技能管理" && !c.disabled)) {
    bad.push("「技能管理」本该能点（本机版接得上）");
  }
  /* 点了要真有后果 */
  if (!out.afterManageCmd?.managePage) {
    bad.push(`点「技能管理」没进管理子页（面包屑：${JSON.stringify(out.afterManageCmd?.crumb)}）`);
  }
  if (!String(out.afterManageCmd?.crumb ?? "").includes("管理")) {
    bad.push(`管理页没出现面包屑：${JSON.stringify(out.afterManageCmd?.crumb)}`);
  }
  if (!out.afterProjectCmd) bad.push("点「选择项目」没打开项目 chip 的下拉");

  /* ＋ 菜单里"从本机添加资料"要在，且**能点**（不是灰掉的占位） */
  if (!out.addMenu) bad.push("输入区 ＋ 菜单里没有「从本机添加资料」（wb-add-file）");
  else {
    if (!out.addMenu.label.includes("添加资料")) bad.push(`那一项写的不是"添加资料"：${JSON.stringify(out.addMenu.label)}`);
    if (out.addMenu.disabled) bad.push("「从本机添加资料」是禁用的（那又成了一个占位）");
  }

  if (out.error) bad.push("异常: " + out.error);
  if (bad.length) {
    console.error("✗ " + bad.join("；"));
    process.exitCode = 1;
  } else {
    console.log("✓ 输入区 chip / 技能面板（版面 + 命令区逐条能点）/ 下拉三件都成立");
  }
}
