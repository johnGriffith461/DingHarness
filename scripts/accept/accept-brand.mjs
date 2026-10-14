/*
 * 验收：Ding Harness 视觉系统（字体三族 / 纸白·暖墨双主题 / 一处朱红 / 区块标题族）。
 *
 * ## 为什么需要它
 * 这套东西落地时是**逐条量出来**的（`.verify/probe-brand-*.mjs` 那几条探针：
 * 字体分片真加载、令牌真解析、渐变真换暖）—— 但那些探针在 `.verify/` 里，
 * 目录整个被 gitignore，**换台机器就没了**，也不会在批跑里跑。
 *
 * 而它要挡的是这个仓库吃过太多次的那类失效：**不报错、不崩、只是某处不对**。
 * 最典型的是渐变 —— 落地时我漏掉了一整族（`--grad-*`：清点器只认 `#hex`，
 * `linear-gradient(...)` 被跳过），最后是**看截图**才发现手机遥控页那块浅蓝。
 * 那类东西只有写成断言才拦得住。
 *
 * ## 判据都是可证伪的
 *   · 三族：`fonts.load()` 真去拉分片，拉不到就红（不是"声明了就算"）；
 *   · 变量：搭一个临时元素 `background: var(--x)` 再读计算值 —— **这样才会展开 var()**，
 *     直接读 `--x` 拿到的是未展开的原文，等于没验证；
 *   · 冷色：逐个色停判「红 ≥ 蓝」，浅色工作台里不许再出现蓝；
 *   · 标题族：区块标题必须是衬线，**画布里的标题必须不是**（那条是显式排除的）。
 *
 * ⚠️ 与产品无关的都不算进来：`--kind-*` / `--violet`（文件类型身份色）、
 * `--ok`（语义绿）本来就**不是**暖色；外壳 `.app`/`.side` 与画布 `.wb-canvas`
 * 按提案 §08 保持深色（那两处的旧蓝是自洽的）。所以断言只覆盖浅色工作台。
 */
import { chromium } from "playwright";
import fs from "node:fs";
import { openApp, killLeftovers, killTree } from "./harness.mjs";

const DATA = "D:/DoubaoWorkClone/.verify/brand-data";
fs.rmSync(DATA, { recursive: true, force: true });
await killLeftovers();

/** 浅色工作台里**必须**是暖色的令牌（挑的是"调色板承载项"，见文件头）。 */
const WARM_TOKENS = [
  "--bg", "--bg-1", "--bg-2", "--bg-3", "--bg-4", "--bg-5",
  "--line", "--line-soft", "--line-strong", "--line-mid", "--line-faint", "--line-faint-2",
  "--fg", "--fg-2", "--fg-3", "--fg-dim", "--fg-faint", "--fg-ghost", "--fg-deep", "--fg-deep-2",
  "--fg-slate", "--fg-disabled",
  "--accent", "--accent-strong", "--accent-tint", "--on-accent", "--focus-ring",
  "--tint-blue", "--tint-blue-2", "--tint-blue-3",
  "--surface-hover", "--surface-active", "--surface-soft", "--surface-selected", "--surface-tint",
];

/** 6 个装饰性渐变：每个色停都必须暖（它们原来整套是蓝的）。 */
const WARM_GRADS = ["--grad-avatar", "--grad-avatar-xs", "--grad-blob", "--grad-feature-art", "--grad-plugin-icon", "--grad-phone-mock"];

const out = {};
const bad = [];
const booted = await openApp(chromium, { port: 9851, dataDir: DATA });
const { browser, page, child } = booted;
const logs = [];

/** 切到某一档并重载（判据要**确定性**：不能受这台机器的系统主题影响）。 */
async function setTheme(theme) {
  await page.evaluate((t) => localStorage.setItem("dsh-canvas.theme", t), theme);
  await page.reload();
  await page.waitForSelector('[data-testid="wb"]', { timeout: 25000 });
  await page.waitForTimeout(2600);
}

try {
  page.on("console", (m) => {
    if (m.type() === "error") logs.push(m.text().slice(0, 140));
  });
  page.on("pageerror", (e) => logs.push(`pageerror: ${String(e).slice(0, 140)}`));

  await page.waitForSelector('[data-testid="wb"]', { timeout: 25000 });
  await page.waitForTimeout(2600);
  await setTheme("light");

  /* ---- 1. 三族真加载（force-load 各自要用的分片；只要有一片 error 就算坏）---- */
  out.fonts = await page.evaluate(async () => {
    const probe = [
      ["display", '600 24px "Noto Serif SC Variable"', "把方案落成产品"],
      ["text", '400 13px "MiSans VF"', "今天有什么工作要处理"],
      ["mono", '400 11px "Martian Mono Variable"', "0123 ABCD"],
    ];
    const res = {};
    for (const [k, spec, text] of probe) {
      try {
        const faces = await document.fonts.load(spec, text);
        res[k] = { loaded: faces.filter((f) => f.status === "loaded").length, status: faces.map((f) => f.status) };
      } catch (e) {
        res[k] = { error: String(e).slice(0, 90) };
      }
    }
    const all = [...document.fonts];
    res.errorFaces = all.filter((f) => f.status === "error").length;
    res.totalFaces = all.length;
    return res;
  });
  for (const k of ["display", "text", "mono"]) {
    const r = out.fonts[k];
    if (r.error || !r.loaded) bad.push(`⭐ ${k} 族没加载到（${JSON.stringify(r)}）`);
  }
  if (out.fonts.errorFaces) bad.push(`⭐ 有 ${out.fonts.errorFaces} 个字体分片是 error 状态`);

  /* ---- 2. 阅读族作用在文字上（两处：body 与工作台自带的那行）---- */
  out.applied = await page.evaluate(() => {
    const wb = document.querySelector(".wb");
    return { body: getComputedStyle(document.body).fontFamily, wb: wb ? getComputedStyle(wb).fontFamily : null };
  });
  for (const [k, v] of Object.entries(out.applied)) {
    if (!/MiSans VF/.test(v ?? "")) bad.push(`⭐ ${k} 没走「阅读」族：${v}`);
  }

  /* ---- 3+4. 日间：纸白 + 朱红，且**没有任何冷色令牌/渐变** ---- */
  out.day = await page.evaluate(
    ({ tokens, grads }) => {
      const wb = document.querySelector(".wb");
      const cs = getComputedStyle(wb);
      // 临时元素上 background: var(--x) —— 只有这样读到的计算值才**展开 var()**
      // ⚠️ 两个坑（第一版都踩了）：① 元素必须挂在 `.wb` **里面**，令牌是定义在 `.wb` 上的，
      //    挂在 body 上取不到（算出来是 none）；② 纯色落在 `background-color`、
      //    渐变落在 `background-image`，读哪个得按有没有渐变挑。
      const host = document.querySelector(".wb") ?? document.body;
      const resolve = (token) => {
        const el = document.createElement("div");
        el.style.background = `var(${token})`;
        host.appendChild(el);
        const cs2 = getComputedStyle(el);
        const v = cs2.backgroundImage !== "none" ? cs2.backgroundImage : cs2.backgroundColor;
        el.remove();
        return v;
      };
      const stops = (v) => [...v.matchAll(/rgba?\((\d+),\s*(\d+),\s*(\d+)/g)].map((m) => ({ r: +m[1], g: +m[2], b: +m[3] }));
      const cool = [];
      for (const t of tokens) {
        const v = resolve(t);
        const st = stops(v);
        if (!st.length) {
          cool.push(`${t}(读不出来: ${v.slice(0, 28)})`);
          continue;
        }
        if (st.some((s) => s.b > s.r)) cool.push(`${t}(${st.map((s) => `rgb(${s.r},${s.g},${s.b})`).join(" ")})`);
      }
      const coolGrads = [];
      for (const t of grads) {
        const v = resolve(t);
        const st = stops(v);
        if (!st.length || st.some((s) => s.b > s.r)) coolGrads.push(`${t}(${v.slice(0, 60)})`);
      }
      return {
        theme: document.documentElement.getAttribute("data-theme"),
        wbBg: cs.backgroundColor,
        accent: cs.getPropertyValue("--accent").trim(),
        tint: cs.getPropertyValue("--tint-blue").trim(),
        coolTokens: cool,
        coolGrads,
      };
    },
    { tokens: WARM_TOKENS, grads: WARM_GRADS },
  );
  if (out.day.theme !== "light") bad.push(`⭐ 强制浅色后 data-theme=${out.day.theme}`);
  if (out.day.wbBg !== "rgb(251, 250, 247)") bad.push(`⭐ 工作台底色不是纸白 #fbfaf7：${out.day.wbBg}`);
  if (out.day.accent !== "#9a2f1c") bad.push(`⭐ 日间 accent 不是朱红 #9a2f1c：${out.day.accent}`);
  if (out.day.tint !== "#f6e9e4") bad.push(`⭐ 选中底不是淡朱 #f6e9e4：${out.day.tint}`);
  if (out.day.coolTokens.length) bad.push(`⭐ 浅色工作台里还有冷色令牌：${out.day.coolTokens.join(" / ")}`);
  if (out.day.coolGrads.length) bad.push(`⭐ 装饰渐变里还有冷色：${out.day.coolGrads.join(" / ")}`);

  /* ---- 5. 区块标题走「表达」族；画布里的标题**不走** ---- */
  out.heads = await page.evaluate(() => {
    const font = (el) => getComputedStyle(el).fontFamily.split(",")[0].replace(/"/g, "");
    const page = [...document.querySelectorAll(".wb h1, .wb h2")].filter((el) => !el.closest(".wb-canvas") && el.getBoundingClientRect().width > 0);
    const canvas = [...document.querySelectorAll(".wb-canvas h1, .wb-canvas h2")];
    return { page: page.map(font), canvas: canvas.map(font) };
  });
  if (!out.heads.page.length) bad.push("⭐ 找不到任何区块标题（h1/h2）—— 判据落空了");
  if (out.heads.page.some((f) => f !== "Noto Serif SC Variable")) {
    bad.push(`⭐ 区块标题没走「表达」族：${out.heads.page.join(" / ")}`);
  }
  /*
   * 画布里的 h1/h2 是 **markdown 节点正文里的标题**（用户/模型写进去的内容），
   * 不是界面标题 —— 落地时**显式排除**了它（`.wb-canvas h1/h2 { font-family: inherit }`）。
   *
   * ⚠️ 这条是**有条件的**：空白画布、或画布里没有 markdown 节点时，一个 h1/h2 都没有，
   * 它自然通过 —— 不算"验证过了"。那次是用「新建 markdown 节点」的探针做的
   * （实测：节点里的标题仍解析成 MiSans VF）。
   */
  if (out.heads.canvas.some((f) => f === "Noto Serif SC Variable")) {
    bad.push(`⭐ 画布里的 markdown 标题被换成了衬线（那条是显式排除的）：${out.heads.canvas.join(" / ")}`);
  }

  /* ---- 6. 黑夜档：暖墨 + 提亮的朱红，且重载后保持 ---- */
  await setTheme("dark");
  out.night = await page.evaluate(() => {
    const cs = getComputedStyle(document.querySelector(".wb"));
    return {
      theme: document.documentElement.getAttribute("data-theme"),
      stored: localStorage.getItem("dsh-canvas.theme"),
      wbBg: cs.backgroundColor,
      accent: cs.getPropertyValue("--accent").trim(),
    };
  });
  if (out.night.theme !== "dark" || out.night.stored !== "dark") bad.push(`⭐ 深色档没保持：${JSON.stringify(out.night)}`);
  if (out.night.wbBg !== "rgb(23, 22, 15)") bad.push(`⭐ 黑夜底色不是暖墨 #17160f：${out.night.wbBg}`);
  if (out.night.accent !== "#d9603a") bad.push(`⭐ 黑夜 accent 没提亮：${out.night.accent}`);

  /* ---- 7. 控制台干净（换行符/字体分片 404 之类的会在 Console 里留痕）---- */
  out.consoleErrors = logs;
  if (logs.length) bad.push(`⭐ 控制台有 ${logs.length} 条报错（首条：${logs[0]}）`);
} catch (e) {
  bad.push("异常: " + String(e).slice(0, 200));
} finally {
  if (bad.length) {
    console.error("✗ " + bad.join("\n  "));
    process.exitCode = 1;
  } else {
    console.log("✓ 三族真加载 / 纸白·暖墨双主题且重载保持 / 浅色工作台无冷色令牌与冷色渐变 / 区块标题走衬线（画布内的不走）");
  }
  console.log(JSON.stringify(out, null, 2));
  await killTree(child);
  await browser?.close?.().catch(() => {});
  await killLeftovers();
}
