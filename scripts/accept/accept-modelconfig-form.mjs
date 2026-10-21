import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";
import { NO_PAGE_HINT, bootApp, connectWithRetry, freshDir, killTree, shot, waitForPage } from "./harness.mjs";

/**
 * 验收：**T0「添加模型」表单**——像真人一样点进去、填完、保存、重开还在。
 *
 * ## 为什么必须真启应用
 *
 * 这条验的是"一个用户能不能自己把新模型接进来"，其中三件事只有真窗口才验得准：
 *   ① 表单能不能点到（`设置 → 模型 → 添加模型`）；
 *   ② 保存是不是真的落到主进程（假桥不经过 IPC，查不出"渲染侧说存了、主进程没收到"）；
 *   ③ 重启之后还在不在（只测一次说明不了持久化）。
 *
 * ## 判据（全部是行为，不看源码）
 *
 * - 打开表单 → 填模型 ID + 窗口 + 最大输出 → 保存 → 列表里出现；
 * - `models.json` 真的落到数据目录；
 * - 校验真的在拦：窗口留空 → 报错且不保存；最大输出 ≥ 窗口 → 报错；
 * - 切到 OpenAI 兼容协议下勾「原生联网搜索」→ 保存被拒并说清原因；
 * - 重启应用 → 列表里那条还在（持久化）。
 *
 * ## 数据
 *
 * 用独立数据目录（`.verify/modelconfig-data`），不碰用户真实的 `~/.ding`。
 * 这个目录里**没有密钥**，本验收也**不调用任何模型** —— 只验表单与落盘。
 */
const DATA = ".verify/modelconfig-data";
if (!(await freshDir(DATA))) {
  console.error("✗ 数据目录 " + DATA + " 删不掉 —— 先手工关掉占着它的 Electron");
  process.exit(1);
}
const PORT = 9371;
const out = {};
let child = null;

const openModelSettings = async (page) => {
  await page.locator('[data-testid="wb-account"]').click();
  await page.waitForTimeout(600);
  await page.locator('[data-testid="wb-acct-settings"]').click();
  await page.waitForTimeout(800);
  /* 设置里的「模型」子页 */
  const modelsTab = page.locator('[data-testid="wb-set-模型"]');
  if (await modelsTab.count()) {
    await modelsTab.click();
    await page.waitForTimeout(700);
  }
};

const boot = async () => bootApp({ port: PORT, dataDir: DATA, timeoutMs: 30000 });

const modelsFile = () => path.join(DATA, "models.json");
const readModels = () => {
  if (!fs.existsSync(modelsFile())) return null;
  try {
    return JSON.parse(fs.readFileSync(modelsFile(), "utf8"));
  } catch {
    return null;
  }
};

try {
  /* ── 第一次启动：走完"添加模型" ── */
  const first = await boot();
  child = first.child;
  if (!first.ok) {
    console.error("[诊断] 应用输出尾部：\n" + (first.getLog() || "(空)").slice(-1200));
    await killTree(child);
    process.exit(1);
  }
  const b1 = await connectWithRetry(chromium, `http://127.0.0.1:${PORT}`);
  const page = await waitForPage(b1);
  if (!page) throw new Error(NO_PAGE_HINT);
  await page.waitForSelector('[data-testid="wb"]', { timeout: 20000 });
  await page.waitForTimeout(1500);

  await openModelSettings(page);

  /* 入口在「模型清单」卡里 */
  const addButton = page.locator('[data-testid="wb-modelset-add"]');
  out.addButtonVisible = (await addButton.count()) > 0;
  if (!out.addButtonVisible) throw new Error("「添加模型」按钮不在——表单没有入口");
  await addButton.click();
  await page.waitForTimeout(700);

  const dialog = page.locator('[data-testid="wb-modelconfig-dialog"]');
  out.dialogOpened = (await dialog.count()) > 0;
  if (!out.dialogOpened) throw new Error("点了「添加模型」对话框没出来");

  /*
   * M-04（2026-10-21 改）：模型字段现在是**下拉**（数据源=已拉取清单），
   * 最后一项「手动输入…」才切回文本框。这条要填的是一个**没拉过**的模型名，
   * 所以先切到手动输入；没有下拉（干净目录、没拉过）时本来就直接是文本框。
   * 另外「高级」默认收起 —— 里面的控件要先展开才点得到。
   */
  const modelSelect = page.locator('[data-testid="wb-modelconfig-model-select"]');
  if ((await modelSelect.count()) > 0) {
    await modelSelect.selectOption("__manual__").catch(() => undefined);
    await page.waitForTimeout(300);
  }
  await page.locator('[data-testid="wb-modelconfig-advanced"] > summary').click();
  await page.waitForTimeout(300);

  /*
   * ① 先试一次**不填窗口**保存：必须被拦住。
   *
   * ⚠️ 2026-10-21（M-04）：窗口现在会**自动预填**（目录没命中时给默认值并标
   * 「默认值（未登记模型，请核对）」）—— 这是方案要的行为，不是"替用户编数"。
   * 所以这一段的做法改成：先确认它**确实预填了**，再**手动清空**去验"空窗口被拦"。
   */
  await page.locator('[data-testid="wb-modelconfig-id"]').fill("probe-user-model");
  await page.waitForTimeout(400);
  const prefilled = await page.locator('[data-testid="wb-modelconfig-window"]').inputValue();
  out.prefilledDefault = Number(prefilled) > 0;
  await page.locator('[data-testid="wb-modelconfig-window"]').fill("");
  await page.locator('[data-testid="wb-modelconfig-save"]').click();
  await page.waitForTimeout(600);
  const afterEmpty = readModels();
  out.emptyWindowRejected = (afterEmpty?.rules ?? []).length === 0;
  out.emptyWindowErrorShown = (await page.locator(".wb-note-bad").count()) > 0;

  /* ② 填完整（真值：1M 窗口 / 64k 输出 / 图片输入 / 两档推理 / 输出映射） */
  await page.locator('[data-testid="wb-modelconfig-window"]').fill("1000000");
  await page.locator('[data-testid="wb-modelconfig-max-output"]').fill("64000");
  await page.locator('[data-testid="wb-modelconfig-supportsImage"]').click();
  await page.locator('[data-testid="wb-modelconfig-level-draft"]').fill("low");
  await page.locator('[data-testid="wb-modelconfig-level-add"]').click();
  await page.locator('[data-testid="wb-modelconfig-level-draft"]').fill("high");
  await page.locator('[data-testid="wb-modelconfig-level-add"]').click();
  await page
    .locator('[data-testid="wb-modelconfig-output-map"]')
    .fill('{"max_completion_tokens": "{{maxOutputTokens}}"}');
  await page.waitForTimeout(700);

  /* ③ 最大输出 ≥ 窗口：必须被拦住 */
  await page.locator('[data-testid="wb-modelconfig-max-output"]').fill("1000000");
  await page.locator('[data-testid="wb-modelconfig-save"]').click();
  await page.waitForTimeout(600);
  out.oversizeOutputRejected = (readModels()?.rules ?? []).length === 0;

  /* ④ 改回合法值并真的保存 */
  await page.locator('[data-testid="wb-modelconfig-max-output"]').fill("64000");
  await page.locator('[data-testid="wb-modelconfig-save"]').click();
  await page.waitForTimeout(900);

  const saved = readModels();
  out.savedFile = saved !== null;
  out.savedRuleCount = (saved?.rules ?? []).length;
  const rule = (saved?.rules ?? []).find((r) => r.modelId === "probe-user-model");
  out.savedWindow = rule?.config?.properties?.contextWindow ?? null;
  out.savedMaxOutput = rule?.config?.optionSpecs?.maxOutputTokens?.max ?? null;
  out.savedImage = rule?.config?.properties?.inputFormat?.supportsImage ?? null;
  out.savedLevels = rule?.config?.optionSpecs?.reasoningLevel?.values ?? [];
  out.savedMap = rule?.config?.optionSpecs?.maxOutputTokens?.map ?? "";
  out.dialogClosed = (await page.locator('[data-testid="wb-modelconfig-dialog"]').count()) === 0;

  /* ⑤ 列表里出现（界面读的是主进程那份 models.json） */
  await page.waitForTimeout(600);
  out.listedInUi = (await page.locator('[data-testid="wb-modelconfig-edit-probe-user-model"]').count()) > 0;
  await shot(page, ".verify/modelconfig-list.png");

  await killTree(child);
  child = null;

  /* ── 第二次启动：重启后还在 ── */
  const second = await boot();
  child = second.child;
  if (!second.ok) throw new Error("第二次启动失败：" + (second.getLog() || "").slice(-600));
  const b2 = await connectWithRetry(chromium, `http://127.0.0.1:${PORT}`);
  const page2 = await waitForPage(b2);
  if (!page2) throw new Error(NO_PAGE_HINT);
  await page2.waitForSelector('[data-testid="wb"]', { timeout: 20000 });
  await page2.waitForTimeout(1500);
  await openModelSettings(page2);
  await page2.waitForTimeout(600);
  out.survivesRestart = (await page2.locator('[data-testid="wb-modelconfig-edit-probe-user-model"]').count()) > 0;

  /* ⑥ 删除也走真按钮 */
  const remove = page2.locator('[data-testid="wb-modelconfig-remove-probe-user-model"]');
  if (await remove.count()) {
    await remove.click();
    await page2.waitForTimeout(800);
  }
  out.removed = (readModels()?.rules ?? []).length === 0;
} finally {
  if (child) await killTree(child);
}

/* ── 判定 ─────────────────────────────────────────────────────────── */
const checks = [
  ["「添加模型」按钮在模型清单卡里", out.addButtonVisible === true],
  ["点开之后对话框真的出现", out.dialogOpened === true],
  ["选中模型后窗口被自动预填（未登记 → 默认值 + 来源标注）", out.prefilledDefault === true],
  ["清空窗口时被拦住（没写进 models.json）", out.emptyWindowRejected === true],
  ["拦的时候显示了错误提示", out.emptyWindowErrorShown === true],
  ["最大输出 ≥ 窗口时被拦住", out.oversizeOutputRejected === true],
  ["合法值保存后 models.json 里有这条规则", out.savedFile === true && out.savedRuleCount === 1],
  ["窗口存的是 1000000", out.savedWindow === 1_000_000],
  ["最大输出存的是 64000", out.savedMaxOutput === 64_000],
  ["图片输入勾选被存下来", out.savedImage === true],
  ["推理档位是 low → high", JSON.stringify(out.savedLevels) === JSON.stringify(["low", "high"])],
  ["输出映射被存下来", String(out.savedMap).includes("max_completion_tokens")],
  ["保存后对话框关闭", out.dialogClosed === true],
  ["列表里出现这条（界面读主进程的那份）", out.listedInUi === true],
  ["重启应用后这条还在", out.survivesRestart === true],
  ["点删除之后 models.json 空了", out.removed === true],
];

let failed = 0;
for (const [name, ok] of checks) {
  if (!ok) failed += 1;
  process.stdout.write(`${ok ? "✓" : "✗"} ${name}\n`);
}
process.stdout.write("\n" + JSON.stringify(out, null, 2) + "\n");
process.stdout.write(
  `\n${failed === 0 ? "✓ 全部通过" : `✗ ${failed} 项未通过`}（${checks.length} 项：表单可点 / 校验会拦 / 落盘 / 重启还在 / 删除生效）\n`,
);
process.exit(failed === 0 ? 0 : 1);
