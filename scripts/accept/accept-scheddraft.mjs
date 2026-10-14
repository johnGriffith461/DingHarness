import { chromium } from "playwright";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { connectWithRetry, pickPort } from "./harness.mjs";

/**
 * 11.30 验收：任务顶栏的 ⏰ → 用当前任务建定时任务。
 *
 * 两条要验：
 *   1. 跳到定时任务页，且**表单已填好**（标题 + 要做的事）；
 *   2. 草稿是**取走即清**的 —— 离开再回来不能被重新填一遍，
 *      否则用户会以为"上次填的没提交"。
 */
const DATA = "D:/DoubaoWorkClone/.verify/sched-draft";
fs.rmSync(DATA, { recursive: true, force: true });
fs.mkdirSync(DATA, { recursive: true });
const now = Date.now();
fs.writeFileSync(
  path.join(DATA, "tasks.json"),
  JSON.stringify(
    [
      {
        id: "t1",
        title: "行业动态追踪",
        brief: "每天整理三条行业动态并排序",
        createdAt: now,
        stage: "done",
        steps: [{ id: "s1", role: "assistant", text: "好了", at: now }],
        questions: [],
        questionIndex: 0,
        artifacts: [],
      },
    ],
    null,
    2,
  ),
  "utf8",
);

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
env.DSH_CANVAS_DATA_DIR = DATA;

/* 这台机器的回环端口会随机连不上（见 harness.pickPort）→ 起之前先挑一个能用的。 */
const __port = await pickPort([12720]);
const child = spawn(
  "D:/DoubaoWorkClone/node_modules/electron/dist/electron.exe",
  [".", "--remote-debugging-port=" + __port],
  { cwd: "D:/DoubaoWorkClone", env, stdio: ["ignore", "ignore", "ignore"] },
);
await new Promise((r) => setTimeout(r, 8000));

const browser = await connectWithRetry(chromium, "http://127.0.0.1:" + __port);
const pages = browser.contexts()[0].pages();
const page = pages.find((p) => !p.url().startsWith("devtools://")) ?? pages[0];
await page.waitForSelector('[data-testid="wb"]', { timeout: 20000 });
await page.waitForTimeout(1800);

const report = {};
try {
  await page.locator('[data-testid="wb-recent-t1"]').click();
  await page.waitForTimeout(1400);
  report.onTaskPage = await page.locator('[data-testid="wb-task-title"]').textContent();

  // 顶栏 ⏰
  await page.locator('[data-testid="wb-task-schedule"]').click();
  await page.waitForTimeout(1600);
  report.onScheduledPage = await page.locator('[data-testid="wb-page-scheduled"]').count();
  report.prefilledTitle = await page.locator('[data-testid="wb-sched-title"]').inputValue();
  report.prefilledPrompt = await page.locator('[data-testid="wb-sched-prompt"]').inputValue();
  report.notEditing = (await page.locator('[data-testid="wb-sched-editing"]').count()) === 0;
  report.createBtnShown = await page.locator('[data-testid="wb-sched-create"]').count();

  // 离开再回来：草稿应已清掉，不再被填
  await page.locator('[data-testid="wb-nav-home"]').click();
  await page.waitForTimeout(900);
  await page.locator('[data-testid="wb-nav-scheduled"]').click();
  await page.waitForTimeout(1400);
  report.afterReturnTitle = await page.locator('[data-testid="wb-sched-title"]').inputValue();
  report.afterReturnPrompt = await page.locator('[data-testid="wb-sched-prompt"]').inputValue();

  /*
   * ── 表单骨架 / 运行环境 / 推荐卡 / 状态行（2026-10-13 补）──
   *
   * ⚠️ `wb-sched-form` / `wb-sched-env` / `wb-preset-*` / `wb-sched-note` 这几个 testid
   * **原来没有任何脚本引用过**（`src/` × `scripts/accept/` 交叉，见 HANDOFF §208 的零覆盖清单）。
   * 断的是**后果**：
   *   · 表单容器在且**里面有控件**（一个空壳表单是"看着在、其实用不了"的典型）；
   *   · 「运行在」两个选项逐字（云电脑 / 本地电脑）；
   *   · ⭐ 点一张推荐卡 → **标题与「要做的事」真的被填进表单**（不是点了没反应）；
   *   · 空闲时**不该**挂着一条状态提示（那条 note 是给"执行中/执行完/存盘失败"用的）。
   */
  report.formBox = await page.evaluate(() => {
    const box = document.querySelector('[data-testid="wb-sched-form"]');
    return {
      count: box ? 1 : 0,
      fields: box ? box.querySelectorAll("input,select,textarea").length : 0,
      width: box ? Math.round(box.getBoundingClientRect().width) : null,
    };
  });
  report.envOptions = await page.evaluate(() =>
    Array.from(document.querySelectorAll('[data-testid="wb-sched-env"] option')).map((o) => (o.textContent ?? "").trim()),
  );
  report.presetCards = await page.evaluate(() =>
    Array.from(document.querySelectorAll('[data-testid^="wb-preset-"]')).map((e) => ({
      id: e.getAttribute("data-testid"),
      title: e.getAttribute("title") ?? "",
      name: (e.querySelector("b")?.textContent ?? "").trim(),
      summary: (e.querySelector("em")?.textContent ?? "").trim(),
    })),
  );
  const firstPreset = report.presetCards[0];
  if (firstPreset) {
    await page.locator(`[data-testid="${firstPreset.id}"]`).click();
    await page.waitForTimeout(700);
    report.afterPresetTitle = await page.locator('[data-testid="wb-sched-title"]').inputValue();
    report.afterPresetPrompt = await page.locator('[data-testid="wb-sched-prompt"]').inputValue();
  }
  report.noteWhileIdle = await page.locator('[data-testid="wb-sched-note"]').count();
} finally {
  console.log(JSON.stringify(report, null, 2));
  await browser.close().catch(() => undefined);
  child.kill();

  /*
   * 2026-10-13 补：这条脚本**原来一条判定都没有**（只有 console.log(report)）——
   * 在批跑里等于"静默不测"（永远 exit 0）。这里只补**零覆盖那一组**的判定，其余仍是报告。
   */
  const bad = [];
  if (report.formBox?.count !== 1) bad.push("定时任务页没有表单容器（wb-sched-form）");
  if ((report.formBox?.fields ?? 0) < 3) bad.push(`表单里控件太少（标题/要做的事/运行在）：${report.formBox?.fields}`);
  if (!(report.formBox?.width > 200)) bad.push(`⭐ 表单被挤塌了（宽 ${report.formBox?.width}px）`);
  if (JSON.stringify(report.envOptions) !== JSON.stringify(["云电脑", "本地电脑"])) {
    bad.push(`「运行在」选项不对：${JSON.stringify(report.envOptions)}`);
  }
  if ((report.presetCards ?? []).length < 1) bad.push("没有推荐卡（wb-preset-*）");
  else {
    for (const c of report.presetCards) {
      if (!c.name) bad.push(`推荐卡 ${c.id} 没有名字`);
      if (!c.summary) bad.push(`推荐卡 ${c.id} 没有说明`);
    }
    if (report.afterPresetTitle !== report.presetCards[0].name) {
      bad.push(`点推荐卡没把标题填进表单：${JSON.stringify(report.afterPresetTitle)} vs ${report.presetCards[0].name}`);
    }
    if (!(report.afterPresetPrompt ?? "").includes(report.presetCards[0].summary.slice(0, 6))) {
      bad.push(`点推荐卡没把「要做的事」填进表单：${JSON.stringify(report.afterPresetPrompt)}`);
    }
  }
  /* 这条脚本自己的主张（注释里写着"草稿应已清掉"）——原来也没有判定，一并钉住 */
  if (report.afterReturnTitle !== "" || report.afterReturnPrompt !== "") {
    bad.push(`离开再回来草稿没清掉：${JSON.stringify([report.afterReturnTitle, report.afterReturnPrompt])}`);
  }
  if (report.noteWhileIdle !== 0) bad.push("空闲时页头上挂着一条状态提示（那条 note 只该在跑/存盘失败时出现）");
  if (bad.length) {
    console.error("✗ 零覆盖那一组（定时任务表单 / 运行在 / 推荐卡 / 状态行）：" + bad.join("；"));
    process.exitCode = 1;
  } else {
    console.log("✓ 零覆盖那一组成立：表单齐全 / 「运行在」两档逐字 / 推荐卡点了真填表 / 空闲无状态提示");
  }
}
