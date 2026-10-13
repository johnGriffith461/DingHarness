import { chromium } from "playwright";
import { bootApp, freshDir, killTree, shot } from "./harness.mjs";

/**
 * 验收：首页「为你推荐」的卡片形态（§139）。
 *
 * 依据本体首页实机截图（`app-triage/dynamic-ui/shot-doubaowork-chat-chat.png`）：
 * 每张卡是**一行**，由「类目图标 + 类目 + 指令」三段组成，且**一列竖排、各自收窄**。
 *
 * 之前渲染的是一整条字符串 + 一枚统一的 ✨ —— 结构上就少了两段，
 * 只查"卡片渲染出来没有"的断言对它完全无感（卡片一直在）。所以这条**查三段结构**。
 */
const DATA = "D:/DoubaoWorkClone/.verify/sugg-data";
if (!(await freshDir(DATA))) {
  console.error("✗ 数据目录 " + DATA + " 删不掉 —— 先手工关掉占着它的 Electron");
  process.exit(1);
}

const PORT = 9296;
const { child, ok, getLog } = await bootApp({ port: PORT, dataDir: DATA, timeoutMs: 30000 });
if (!ok) {
  console.error("[诊断] 应用输出尾部：\n" + (getLog() || "(空)").slice(-1200));
  await killTree(child);
  process.exit(1);
}

const out = {};
try {
  const b = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
  const page = b.contexts()[0].pages().find((p) => !p.url().startsWith("devtools://"));
  await page.waitForSelector('[data-testid="wb"]', { timeout: 20000 });
  await page.waitForTimeout(2000);

  out.cards = await page.$$eval(".wb-suggestion", (els) =>
    els.map((e) => ({
      icon: e.querySelectorAll(".wb-suggestion-icon svg").length,
      tag: e.querySelector(".wb-suggestion-tag")?.textContent?.trim() ?? null,
      text: e.querySelector(".wb-suggestion-text")?.textContent?.trim() ?? null,
    })),
  );
  out.count = out.cards.length;

  // 一列竖排：所有卡片的左边缘应当一致；且**不是**两列网格（同一行不该有两张卡）
  out.geometry = await page.$$eval(".wb-suggestion", (els) =>
    els.map((e) => {
      const r = e.getBoundingClientRect();
      return { left: Math.round(r.left), top: Math.round(r.top), w: Math.round(r.width) };
    }),
  );
  out.rowCount = new Set(out.geometry.map((g) => g.top)).size;
  out.leftEdges = Array.from(new Set(out.geometry.map((g) => g.left)));

  /*
   * ⚠️ 「为你推荐」这个标签与卡片的**左边缘必须在一条线上**。
   *
   * 这一条是照着本体截图补的：那张图里标签与四张卡的左边缘完全对齐（同一条竖线）。
   * 我第一版让标签 `margin-left: 12%`、卡片块却居中 → 两者错开 60 多像素，
   * **结构全对、就是看着歪**。只断言"卡片之间对齐"是查不出这个的。
   */
  out.labelLeft = await page.evaluate(() => {
    const el = document.querySelector(".wb-home-label");
    return el ? Math.round(el.getBoundingClientRect().left) : null;
  });
  out.cardLeft = out.geometry[0]?.left ?? null;

  out.shot = await shot(page, "suggestions.png");
  await b.close();
} catch (e) {
  out.error = String(e).slice(0, 240);
} finally {
  console.log(JSON.stringify(out, null, 2));
  await killTree(child);

  const bad = [];
  if (out.count !== 4) bad.push(`推荐卡不是 4 张（实际 ${out.count}）—— 实机是四条`);
  for (const [i, c] of (out.cards ?? []).entries()) {
    if (c.icon !== 1) bad.push(`第 ${i + 1} 张卡缺类目图标`);
    if (!c.tag) bad.push(`第 ${i + 1} 张卡缺类目`);
    if (!c.text) bad.push(`第 ${i + 1} 张卡缺指令`);
  }
  if (out.rowCount !== out.count) bad.push(`卡片没有竖排（占用了 ${out.rowCount} 行 / 共 ${out.count} 张）`);
  if ((out.leftEdges ?? []).length !== 1) bad.push(`卡片左边缘没对齐：${JSON.stringify(out.leftEdges)}`);
  if (out.labelLeft === null || out.cardLeft === null || Math.abs(out.labelLeft - out.cardLeft) > 2) {
    bad.push(`「为你推荐」与卡片的左边缘不在一条线上：标签 ${out.labelLeft} vs 卡片 ${out.cardLeft}`);
  }
  if (out.error) bad.push("异常: " + out.error);
  if (bad.length) {
    console.error("✗ " + bad.join("；"));
    process.exitCode = 1;
  } else {
    console.log("✓ 推荐卡：图标 / 类目 / 指令 三段齐，一列竖排左对齐");
  }
}
