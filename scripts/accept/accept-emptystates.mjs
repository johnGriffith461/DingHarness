import { chromium } from "playwright";
import { NO_PAGE_HINT, bootApp, connectWithRetry, freshDir, killTree, openSummary, shot, waitForPage } from "./harness.mjs";

/**
 * 验收：**几条「一个人都没来过」的空态**（2026-10-13 补，§208 那类"没人点过的界面"）。
 *
 * ## 这条**不调模型**，也**不预置任何数据**（空数据目录就是它的场景）
 *
 * ⚠️ 为什么要有这条：把 `src/` 的 `data-testid` 与 `scripts/accept/` 做交叉，
 * 有 96 个前缀**从未被任何脚本引用过**（见 HANDOFF §208 那份零覆盖清单）。
 * 其中「空态」这一小撮最典型 —— 平时跑验收都带着数据，**空态只有真空白时才出现**，
 * 于是它烂了也没人知道（同类事故：技能面板被挤成 59px、中文一字一行，§201）。
 *
 * 这条一次走三个页面 + 一个面板：
 *   ① 「管理历史对话」—— 一条记录都没有时的空态
 *   ② 「任务中心」—— 一条任务都没有时的空态
 *   ③ 右侧「对话摘要」—— 没开任何对话时，产物页签给「暂无」
 *   ④ 右侧「对话摘要 → 图片与视频」—— 云盘/产物空空时给那句**说清去哪生成**的空态
 *
 * 断的是**文案逐字 + 容器宽度**（宽 < 200px 就是被挤塌了 —— 那正是 §201 的死法），
 * 不是"元素在不在"。
 */
const DATA = ".verify/emptystates-data";
if (!(await freshDir(DATA))) {
  console.error("✗ 数据目录 " + DATA + " 删不掉 —— 先手工关掉占着它的 Electron");
  process.exit(1);
}

/* ⚠️ 2026-10-16（审计 G06/G07）：bootApp 会换端口重试 —— 下面用的是它返回的实际端口，不再假设给哪个就用哪个 */
let PORT = 9319;
const booted = await bootApp({ port: PORT, dataDir: DATA, timeoutMs: 30000 });
const { child, ok, getLog } = booted;
/* 用实际端口（bootApp 换过端口时它与首选不同） */
PORT = booted.port;
if (!ok) {
  console.error("[诊断] 应用输出尾部：\n" + (getLog() || "(空)").slice(-1200));
  await killTree(child);
  process.exit(1);
}

const out = {};
try {
  const b = await connectWithRetry(chromium, `http://127.0.0.1:${PORT}`);
  const page = await waitForPage(b);
  if (!page) throw new Error(NO_PAGE_HINT);
  await page.waitForSelector('[data-testid="wb"]', { timeout: 20000 });
  await page.waitForTimeout(1500);

  /** 量一个空态的文案与宽度（宽 < 200 说明这个块被挤塌了）。 */
  const readEmpty = (id) =>
    page.evaluate((tid) => {
      const el = document.querySelector(`[data-testid="${tid}"]`);
      if (!el) return null;
      return { text: (el.textContent ?? "").trim(), width: Math.round(el.getBoundingClientRect().width) };
    }, id);

  /* ① 管理历史对话（左栏「最近」那一行的入口） */
  await page.locator('[data-testid="wb-threads-open"]').click();
  await page.waitForTimeout(900);
  out.threads = await readEmpty("wb-threads-empty");

  /* ② 任务中心 */
  await page.locator('[data-testid="wb-center-open"]').click();
  await page.waitForTimeout(900);
  out.center = await readEmpty("wb-center-empty");

  /* ③④ 右侧「对话摘要」：没开对话 → 产物页签「暂无」；媒体页签给那句"去哪生成" */
  await page.locator('[data-testid="wb-nav-home"]').click();
  await page.waitForTimeout(900);
  /* 右栏 2026-10-14 起默认收起（照原型）→ 先展开，下面读的 `wb-summary-*` 才在 */
  out.summaryOpened = await openSummary(page);
  await page.waitForTimeout(600);
  out.artifactsEmpty = await readEmpty("wb-artifacts-empty");
  await page.locator('[data-testid="wb-summary-tab-media"]').click();
  await page.waitForTimeout(1500);
  out.mediaEmpty = await readEmpty("wb-media-empty");

  out.shot = await shot(page, "emptystates.png");
  await b.close();
} catch (e) {
  out.error = String(e).slice(0, 300);
} finally {
  console.log(JSON.stringify(out, null, 2));
  await killTree(child);

  const bad = [];
  if (out.error) bad.push("异常: " + out.error);

  const cases = [
    {
      key: "threads",
      who: "「管理历史对话」空态",
      want: "还没有对话记录",
      /* 整页级的块，阈值取宽一点 */
      min: 300,
    },
    {
      key: "center",
      who: "「任务中心」空态",
      want: "置顶、最近访问的内容和进行中的任务将展示在这里",
      min: 300,
    },
    /*
     * ⚠️ 下面两个在**右侧摘要面板里**（面板本身只有 225px 宽，扣掉 14px 内边距只剩约 197px），
     * 所以阈值取 120：这已经足够抓住"被挤塌"（§201 那次是 59px），又不会把正常宽度判红。
     */
    { key: "artifactsEmpty", who: "摘要面板的产物空态", want: "暂无", min: 120 },
    { key: "mediaEmpty", who: "摘要面板的媒体空态", want: "还没有图片或视频", min: 120 },
  ];
  for (const c of cases) {
    const got = out[c.key];
    if (!got) {
      bad.push(`${c.who}没出现（没有对话记录/任务/媒体时就该是它）`);
      continue;
    }
    if (!got.text.includes(c.want)) bad.push(`${c.who}文案不对：${JSON.stringify(got.text)}`);
    if (!(got.width > c.min)) bad.push(`⭐ ${c.who}被挤塌了（宽 ${got.width}px）—— 中文会一字一行`);
  }

  if (bad.length) {
    console.error("✗ " + bad.join("；"));
    process.exitCode = 1;
  } else {
    console.log("✓ 空态成立：历史对话 / 任务中心 / 摘要产物 / 摘要媒体 四处都有话直说，且都没有被挤塌");
  }
}
