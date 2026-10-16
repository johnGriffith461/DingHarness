import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * 验收脚本引用的 `data-testid` 必须在源码里**真的存在**（2026-10-16，审计 G21 同族 / §56）。
 *
 * ## 为什么需要
 *
 * 左栏那个 `wb-nav-plugins` 被拆掉之后，**7 条脚本**红的是"脚本过期"而不是产品坏了；
 * 而 §97 撞到的是更坏的一种：脚本过期之后**静默跳过**那几步，仍然报绿。
 * 两种都要人肉判断一次 —— 这条守卫把"引用了不存在的 testid"变成一次机器判定。
 *
 * 判定：源码里的 testid 分**静态字面量**（精确相等）与**模板前缀**
 * （`data-testid={`wb-x-${y}`}` → 允许前缀匹配）；脚本里出现的字面量两类都不命中就算过期。
 *
 * ⚠️ 白名单里那些是**已知仍在过期**的（修它们要动到对应脚本的判定，逐条在做）。
 * 白名单只该**变短**：新增的过期会立刻红。
 */

const ROOT = path.resolve(__dirname, "..");
const SCRIPT_DIR = path.join(ROOT, "scripts", "accept");

/**
 * **故意查一个已经删掉的 testid** 的地方（断言"这个入口确实没了"）—— 不是过期，是正常断言。
 *
 * ⚠️ 为什么单列一类（2026-10-16）：原先它们和"脚本过期"挤在同一张白名单里，
 * 于是一件很要紧的事被混掉了 —— **过期是债（要还），断言不存在是判据（要留）**。
 * 混在一起看，谁也不知道白名单里还剩几条是"真的坏了"。
 *
 * 判据不是"作者说了算"：下面每一条都要求脚本里那行**写明了"没有"**
 * （`=== 0` 或 `? … : null` 那种），守卫会逐行核对（见 `absenceCheckOk`）。
 */
const GONE_EXPECTED: Record<
  string,
  {
    ids: string[];
    why: string;
    /**
     * 这条脚本"断它不存在"的写法：
     *   · `count-zero`  —— 数出来必须是 0 / null（`=== 0`、`? … : null`、`=== null`）；默认这一型
     *   · `truthy-red`  —— 数出来只要不是 0 就判红（`if (n || m) bad.push(…)`）
     * 判据不是"作者说了算"：守卫按这个字段去那一行附近核对（见 `absenceCheckOk`）。
     */
    check?: "count-zero" | "truthy-red";
  }
> = {
  "accept-chips.mjs": {
    ids: ["wb-env"],
    why: "「环境」入口搬进设置之后，输入区那颗 chip 就不该再有了 —— 脚本断的就是这件事（`envChipGone`）",
  },
  "accept-threads.mjs": {
    ids: ["wb-threads-more"],
    why: "批量操作入口 2026-10-15 被移除（M0 工单 3）—— 脚本断的是「它真的没了、没留下半个死按钮」",
  },
  "accept-scheddraft.mjs": {
    ids: ["wb-sched-env"],
    why: "定时任务草稿的旧「环境」选择器换过一轮 —— 脚本断的是旧节点不再出现",
  },
  "accept-modelchip.mjs": {
    ids: ["wb-model-search", "wb-model-pull-"],
    why: "模型弹层**不该**有搜索框与「拉取模型」（那是设置页的事）—— 弹层只负责「这一轮用哪个」",
    check: "truthy-red",
  },
  "accept-custom.mjs": {
    ids: ["wb-skill-toggle-"],
    why: "技能选择器改版后旧 testid 必须清干净 —— 脚本两向都断：旧的必须是 0、新面板里必须有「技能管理」入口",
  },
};



/**
 * 已知仍在过期、**逐条在修**的（键=脚本名，值=引用的 testid）。
 *
 * ⚠️ 这张表只该**变短**：`MAX_STALE` 是它的棘轮。要新增一条得有理由 ——
 * 而"我只是还没来得及改脚本"不算理由，那正是要修的东西。
 */
const KNOWN_STALE: Record<string, string[]> = {
  /* 这条脚本自己头部就写着「**不要引用它来证明任何事**」：零判定 + 已知过期，重写它是一件独立的活 */
  "accept-library.mjs": ["wb-skill-toggle-", "wb-navmenu-"],
};

/** 过期项总数的棘轮（只许往下调）。 */
const MAX_STALE = 2;

/** 这一行是不是「在断它不存在」（`=== 0` / `=== null` / `? … : null` / `!document.querySelector`）。 */
function absenceCheckOk(line: string, style: "count-zero" | "truthy-red" = "count-zero"): boolean {
  if (style === "truthy-red") return /bad\.push/.test(line);
  return /===\s*0|!==\s*0|===\s*null|!==\s*null|\?.*:\s*null|!document\.querySelector|toBeNull|toBeFalsy/.test(line);
}

/** runner 的 `NOT_IN_BATCH` 里标成 `retired` 的那些（退役的墓碑不参与 testid 对账）。 */
function retiredScripts(): Set<string> {
  const text = readFileSync(path.join(ROOT, "scripts/verify-acceptances.mjs"), "utf8");
  const out = new Set<string>();
  for (const m of text.matchAll(/^\s*"([^"]+\.mjs)":\s*\{\s*kind:\s*"retired"/gm)) out.add(m[1]!);
  return out;
}

function collectSourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === "node_modules") continue;
      collectSourceFiles(full, out);
    } else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) {
      out.push(full);
    }
  }
  return out;
}

describe("验收脚本的 testid 与源码对齐", () => {
  it("脚本引用的每个 data-testid 都能在源码里找到（白名单之外的过期会红）", () => {
    const staticIds = new Set<string>();
    const dynamicPrefixes = new Set<string>();
    for (const file of [
      ...collectSourceFiles(path.join(ROOT, "src")),
      ...collectSourceFiles(path.join(ROOT, "electron")),
    ]) {
      const text = readFileSync(file, "utf8");
      for (const m of text.matchAll(/data-testid=\{?["']([^"'`${}]+)["']\}?/g)) staticIds.add(m[1]!);
      for (const m of text.matchAll(/data-testid=\{`([^`$]+)\$\{/g)) dynamicPrefixes.add(m[1]!);
      for (const m of text.matchAll(/data-testid=\{["']([^"'`${}]+)["']\s*\+/g)) dynamicPrefixes.add(m[1]!);
      for (const m of text.matchAll(/data-testid=\{[^}]*?\?\s*["']([^"'`${}]+)["']/g)) dynamicPrefixes.add(m[1]!);
      for (const m of text.matchAll(/data-testid=\{[^}]*?:\s*["']([^"'`${}]+)["']/g)) dynamicPrefixes.add(m[1]!);
      /*
       * ⚠️ **共用组件那一族**（2026-10-16 补）：`ContextMenu`/`ToolTraceList` 这类组件把
       * testid 做成**默认形参**（`testid = "wb-menu"` / `actionPrefix = "wb-tool"`），
       * 然后 `data-testid={testid}` 或 `` data-testid={`${actionPrefix}-allow-${id}`} `` 用出去。
       * 上面那几行正则只看得到 `{testid}` 这个大括号，看不到值 —— 于是
       * `wb-menu`、`wb-tool-allow-`、`wb-menu-` 全被误判成"源码里不存在"，
       * 白名单里就长期挂着三条**根本没坏**的脚本。**守卫的假红也是缺陷**：
       * 它逼着人往白名单里加东西，加着加着真过期的就淹进去了。
       */
      for (const m of text.matchAll(/\b([A-Za-z_$][\w$]*)\s*=\s*["']([^"'`]+)["']/g)) {
        const name = m[1]!;
        const value = m[2]!;
        if (!/testid|prefix/i.test(name)) continue;
        // 直接当 testid 用：`data-testid={testid}`
        if (new RegExp(`data-testid=\\{${name}\\}`).test(text)) staticIds.add(value);
        // 拼进模板用：把 `${name}` 换成值、再切到第一个残留的 `${` —— 那之前就是前缀
        for (const t of text.matchAll(/data-testid=\{`([^`]*)`\}/g)) {
          const body = t[1]!;
          if (!body.includes(`\${${name}}`)) continue;
          const expanded = body.split(`\${${name}}`).join(value);
          const cut = expanded.indexOf("${");
          if (cut < 0) staticIds.add(expanded);
          else dynamicPrefixes.add(expanded.slice(0, cut));
        }
      }
      /*
       * 组件 props 传进来的（`<ContextMenu testid="wb-navmenu" />`）：
       * 值本身是一个 id，而**条目**的 id 是 `${testid}-${item.label}`（见 `ContextMenu`），
       * 所以值加个短横也是合法前缀 —— 不补这一条，`accept-rowmenu` 的 `wb-navmenu-` 会被误判。
       */
      for (const m of text.matchAll(/\btestid=\{?["']([^"'`${}]+)["']\}?/g)) {
        staticIds.add(m[1]!);
        dynamicPrefixes.add(m[1]! + "-");
      }
      for (const m of text.matchAll(/\btestid=\{`([^`$]+)\$\{/g)) dynamicPrefixes.add(m[1]!);
    }
    const known = (id: string): boolean => staticIds.has(id) || [...dynamicPrefixes].some((p) => p && id.startsWith(p));

    /*
     * 退役脚本**不参与**这里的对账：它是墓碑（脚本头部写着"不要拿它证明任何事"），
     * 引用的 testid 本来就该是死的。这不是后门 —— "退役"这件事由
     * `acceptRegistry.test.ts` 与 runner 的 `NOT_IN_BATCH` 管着（每条都要写 why，
     * 而且 `debt`/`fossil` 有数字棘轮）。
     */
    const retired = retiredScripts();

    const offenders: string[] = [];
    for (const name of readdirSync(SCRIPT_DIR)) {
      if (!name.startsWith("accept-") || !name.endsWith(".mjs")) continue;
      if (retired.has(name)) continue;
      const text = readFileSync(path.join(SCRIPT_DIR, name), "utf8");
      const allowed = new Set(KNOWN_STALE[name] ?? []);
      const ids = new Set<string>();
      const prefixIds = new Set<string>();
      for (const m of text.matchAll(/data-testid=["']([^"'`$]+)["']/g)) ids.add(m[1]!);
      /*
       * 前缀写法 `[data-testid^="x-"]` 的正确判据是"**至少有一个**源码 testid 以它开头"
       * （可能匹配到几个静态 id，也可能匹配到模板前缀）—— 不是"存在一个模板以它开头"。
       */
      for (const m of text.matchAll(/data-testid\^=["']([^"'`$]+)["']/g)) prefixIds.add(m[1]!);
      const gone = new Set(GONE_EXPECTED[name]?.ids ?? []);
      for (const id of ids) {
        if (known(id) || allowed.has(id) || gone.has(id)) continue;
        offenders.push(`${name} → ${id}`);
      }
      for (const id of prefixIds) {
        if (allowed.has(id) || gone.has(id)) continue;
        const hit =
          [...staticIds].some((s) => s.startsWith(id)) ||
          [...dynamicPrefixes].some((q) => q.startsWith(id)) ||
          /*
           * ⭐ **脚本自己给出实例也算证据**：同一份脚本里还写了这个前缀下的某个**字面量**
           * （`[data-testid^="wb-agent-tag-background-"]` 与 `[data-testid="wb-agent-tag-background-老师"]` 并存），
           * 而那个字面量在源码里找得到 —— 那这个前缀就不是凭空写的。
           *
           * 为什么需要这一条：源码那头是模板（`wb-agent-tag-${组}-${标签}`），
           * **静态判不出"组名"这一段**（它来自运行时的 `AGENT_TAG_GROUPS`）。
           * 判据只能是"脚本里有个能对上的实例"。没有实例、又对不上源码的前缀，照样红。
           */
          [...ids].some((literal) => literal.startsWith(id) && (staticIds.has(literal) || [...dynamicPrefixes].some((q) => literal.startsWith(q))));
        if (!hit) offenders.push(`${name} → ${id}（前缀写法）`);
      }
    }
    expect(
      offenders,
      "这些脚本引用的 testid 在源码里不存在了（脚本过期，或 testid 被改名）—— 修脚本，或（若确认要退休）把它写进本文件的白名单并说明理由",
    ).toEqual([]);
  });

  it("⭐ 声明「故意断言不存在」的，那一行必须真的在断「没有」", () => {
    /*
     * ⚠️ 这条是给 `GONE_EXPECTED` 上的锁：那张表放行的是"脚本故意去查一个已经删掉的 testid"。
     * 可它一旦可以随便写，就会变成后门 —— 谁都能把过期引用塞进去、然后它就不再红了。
     * 所以放行的同时要求**脚本里那行真的写了"它不存在"**（`=== 0` / `? … : null` / `!querySelector`）。
     * 判据轻，但足够挡住"顺手把过期项挪进去"这个动作。
     */
    for (const [name, entry] of Object.entries(GONE_EXPECTED)) {
      const lines = readFileSync(path.join(SCRIPT_DIR, name), "utf8").split("\n");
      for (const id of entry.ids) {
        /*
         * ⚠️ 判据看的是 id 那行**±3 行**的窗口，不是只看那一行：
         * 常见写法是先取值、再判（`const e = document.querySelector('[data-testid="x"]'); out.gone = e === null;`）——
         * 只盯同一行会把这种正当写法判红（第一版就这么把 accept-threads 判了）。
         */
        const idx = lines.map((l, i) => (l.includes(id) ? i : -1)).filter((i) => i >= 0);
        expect(idx.length, `${name} 声明「故意断言 ${id} 不存在」，但脚本里一个字都没提它`).toBeGreaterThan(0);
        const window = lines.filter((_, i) => idx.some((j) => Math.abs(i - j) <= 3));
        expect(
          window.some((l) => absenceCheckOk(l, entry.check)),
          `${name} 提到 ${id} 的那一行没有「它不存在」的写法（\`=== 0\` / \`? … : null\`）—— 要么这其实是过期引用，要么把判据写清楚`,
        ).toBe(true);
      }
    }
  });

  it("⏳ 过期项总数只许少不许多（棘轮）", () => {
    /*
     * ⚠️ 与 `structureGuard` 的行数上限、`themeRatchet` 的硬编码上限同一个套路：
     * 「还没改的过期」是可以存在的**债**，但它必须有个数字，而且这个数字只许往下。
     * 修好一条就把 `MAX_STALE` 减一 —— 不许"顺手再加一条"。
     */
    const total = Object.values(KNOWN_STALE).reduce((n, ids) => n + ids.length, 0);
    expect(
      total,
      `过期项比上限多（现在 ${total} 条 / 上限 ${MAX_STALE} 条）——「没来得及改脚本」不是加条目的理由，那正是要修的东西`,
    ).toBeLessThanOrEqual(MAX_STALE);
    expect(total, "棘轮只许往下调：过期修少了，就把 MAX_STALE 也调小").toBe(MAX_STALE);
  });
});
