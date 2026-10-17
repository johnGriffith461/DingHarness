import { chromium } from "playwright";
import { spawn } from "node:child_process";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { connectWithRetry, freshDir, killTree, pickPort, shot, waitForPort } from "./harness.mjs";

/**
 * 验：设置 →「团队空间」这一页**真能改账本**（V5-3 的产品面）。
 *
 * 这一条是"常驻验收"（真起应用、真点界面），判据分两层：
 *   ① 界面上：发一张码 → 码显示出来了 → 填表替他入团 → 名册里出现那个人、
 *      口令**显示了一次** → 改角色 → 移除 → 名册里没了；
 *   ② **磁盘上**：`<数据目录>/space.json` 里真的多了那个人（名册 + 口令），
 *      移除之后那个人与口令都没了 —— 只看界面会漏掉"界面自己骗自己"这一类。
 *
 * ⚠️ 数据目录是 `.verify/team-data`（每次清空）；应用只认 `DSH_CANVAS_DATA_DIR`。
 */
const DATA = ".verify/team-data";
if (!(await freshDir(DATA))) {
  console.error("✗ 数据目录 " + DATA + " 删不掉 —— 先手工关掉占着它的 Electron");
  process.exit(1);
}
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
env.DSH_CANVAS_DATA_DIR = DATA;

const __port = await pickPort([12997]);
env.DSH_DEBUG_PORT = String(__port);
const child = spawn("node_modules/electron/dist/electron.exe", [".", "--remote-debugging-port=" + __port], {
  cwd: ".",
  env,
  stdio: ["ignore", "ignore", "ignore"],
});

/**
 * 读**盘上**的账本（判据②）。读不出来给 null（那样"磁盘"那一半就红）。
 *
 * ⚠️ 空间账不是一份 `space.json` 文件 —— 它落在 `<数据目录>/stores.db` 的 **KV 表**里
 * （`kvStore` 那一层；`spaceStore.file()` 给的是逻辑名，不是路径）。
 * 第一版按"有个 space.json"去读，于是"账本落盘了没有"这条判据永远红 ——
 * 而界面明明改成功了：**判据自己写错**与"产品没做"长得一模一样，这就是为什么要读真库。
 */
function ledger() {
  try {
    const db = new DatabaseSync(path.join(DATA, "stores.db"));
    try {
      const rows = db.prepare("SELECT key, value FROM kv").all();
      for (const row of rows) {
        try {
          const parsed = JSON.parse(String(row.value));
          if (parsed && typeof parsed === "object" && parsed.roster && parsed.tokens) return parsed;
        } catch {
          /* 别的键不是 JSON，跳过 */
        }
      }
      return null;
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}

const out = {};
await waitForPort(__port, 40000);
try {
  const b = await connectWithRetry(chromium, "http://127.0.0.1:" + __port);
  const page = b.contexts()[0].pages().find((p) => !p.url().startsWith("devtools://"));
  await page.waitForSelector('[data-testid="wb"]', { timeout: 20000 });
  await page.waitForTimeout(2200);

  /* 打开设置 → 团队空间 */
  await page.locator('[data-testid="wb-account"]').click();
  await page.waitForTimeout(600);
  await page.locator('[data-testid="wb-acct-settings"]').click();
  await page.waitForTimeout(800);
  out.hasRow = (await page.locator('[data-testid="wb-set-团队空间"]').count()) === 1;
  await page.locator('[data-testid="wb-set-团队空间"]').click();
  await page.waitForTimeout(900);
  out.pageOpen = (await page.locator('[data-testid="wb-setpage-team"]').count()) === 1;
  out.membersAtStart = await page.locator('[data-testid="wb-team-members"] li').count();

  /* ① 发一张码（只读） */
  await page.locator('[data-testid="wb-team-invite-viewer"]').click();
  await page.waitForTimeout(500);
  const codeText = (await page.locator('[data-testid="wb-team-code"]').textContent().catch(() => "")) ?? "";
  const code = /([0-9A-Z]{8})/.exec(codeText)?.[1] ?? "";
  out.code = code;
  out.codeOnDisk = (ledger()?.roster?.codes ?? []).length;

  /* ② 替他入团（alice） */
  await page.locator('[data-testid="wb-team-code-input"]').fill(code);
  await page.locator('[data-testid="wb-team-member-input"]').fill("alice");
  await page.locator('[data-testid="wb-team-name-input"]').fill("Alice");
  await page.locator('[data-testid="wb-team-join"]').click();
  await page.waitForTimeout(700);
  out.aliceRow = (await page.locator('[data-testid="wb-team-member-alice"]').count()) === 1;
  const tokenText = (await page.locator('[data-testid="wb-team-token"]').textContent()) ?? "";
  out.tokenShown = (tokenText.match(/sk-[A-Za-z0-9_-]+/) ?? [""])[0];
  out.tokenShownPrefix = out.tokenShown.slice(0, 3);
  out.rolesShown = (await page.locator('[data-testid="wb-team-roles-alice"]').textContent()) ?? "";
  const afterJoin = ledger();
  out.aliceOnDisk = Boolean(afterJoin?.roster?.members?.some?.((m) => m.id === "alice"));
  out.tokenOnDisk = Boolean(afterJoin?.tokens?.alice);
  /* 口令只在入团那一次显示：页面文本里再搜一次，不该还有第二处 */
  out.tokenCountOnPage = out.tokenShown ? ((await page.locator("body").textContent()) ?? "").split(out.tokenShown).length - 1 : -1;

  /* ③ 改角色 → 升成管理员 */
  await page.locator('[data-testid="wb-team-role-alice"]').selectOption("admin");
  await page.waitForTimeout(600);
  out.rolesAfterPromote = (await page.locator('[data-testid="wb-team-roles-alice"]').textContent()) ?? "";
  out.rolesOnDisk = ledger()?.roster?.members?.find?.((m) => m.id === "alice")?.roles ?? [];

  /* ④ 移除（口令一并作废） */
  await page.locator('[data-testid="wb-team-remove-alice"]').click();
  await page.waitForTimeout(600);
  out.aliceGoneFromUi = (await page.locator('[data-testid="wb-team-member-alice"]').count()) === 0;
  const afterRemove = ledger();
  out.aliceGoneFromDisk = !(afterRemove?.roster?.members ?? []).some?.((m) => m.id === "alice");
  out.tokenGoneFromDisk = !afterRemove?.tokens?.alice;

  /* ④b 共享入口：候选清单与按钮在（空库时如实说"还没有会话可以共享"） */
  out.shareEntry = (await page.locator('[data-testid="wb-team-share-pick"]').count()) === 1 &&
    (await page.locator('[data-testid="wb-team-share"]').count()) === 1;
  out.shareEmptyNote = await page.evaluate(() => document.body.textContent?.includes("本机还没有会话可以共享") ?? false);

  /* ④c 加密房间那一节：入口在、空态如实说 */
  out.roomEntry = (await page.locator('[data-testid="wb-team-room-pick"]').count()) === 1 &&
    (await page.locator('[data-testid="wb-team-room-open"]').count()) === 1;
  out.roomEmptyNote = await page.evaluate(() => document.body.textContent?.includes("还没有房间") ?? false);

  /* ⑤ 账本按钮：真读一遍（表格出来） */
  await page.locator('[data-testid="wb-team-usage"]').click();
  await page.waitForTimeout(900);
  out.usageTable = (await page.locator('[data-testid="wb-team-usage-table"]').count()) === 1;

  out.shot = await shot(page, "team.png");
  await b.close();
} catch (e) {
  out.error = String(e).slice(0, 200);
} finally {
  console.log(JSON.stringify(out, null, 2));
  await killTree(child);
  const bad = [];
  if (!out.hasRow) bad.push("设置里没有「团队空间」那一行");
  if (!out.pageOpen) bad.push("团队空间页没打开");
  if ((out.membersAtStart ?? 0) !== 1) bad.push(`空账该只有主人一个成员（看到 ${out.membersAtStart}）`);
  if (!/^[0-9A-Z]{8}$/.test(out.code ?? "")) bad.push("没有发出配对码");
  if ((out.codeOnDisk ?? 0) < 1) bad.push("配对码没进账本");
  if (!out.aliceRow) bad.push("入团后名册里没有 alice");
  if ((out.tokenShownPrefix ?? "") !== "sk-") bad.push("口令没有显示（或形状不对）");
  if (!out.aliceOnDisk) bad.push("alice 没进账本（界面自己骗自己？）");
  if (!out.tokenOnDisk) bad.push("口令没进账本");
  if (out.tokenCountOnPage !== 1) bad.push(`口令在页面上出现了 ${out.tokenCountOnPage} 次（该只有一处）`);
  if (!(out.rolesShown ?? "").includes("只读")) bad.push("入团后的角色不是只读起步（viewer）");
  if (!(out.rolesAfterPromote ?? "").includes("管理员")) bad.push("改角色没生效（界面上）");
  if (!(out.rolesOnDisk ?? []).includes("admin")) bad.push("改角色没落盘");
  if (!out.aliceGoneFromUi) bad.push("移除之后名册里还有 alice");
  if (!out.aliceGoneFromDisk) bad.push("移除没落盘");
  if (!out.tokenGoneFromDisk) bad.push("移除之后口令还在账上（那样撤权只是「以后不行」）");
  if (!out.usageTable) bad.push("账本按钮没出表");
  if (!out.shareEntry) bad.push("共享入口（挑会话 + 共享按钮）不在页面上");
  if (!out.shareEmptyNote) bad.push("空库时没有如实说「本机还没有会话可以共享」");
  if (!out.roomEntry) bad.push("加密房间那一节的入口不在页面上");
  if (!out.roomEmptyNote) bad.push("没有房间时没有如实说「还没有房间」");
  if (out.error) bad.push("异常: " + out.error);
  if (bad.length) {
    console.error("✗ " + bad.join("；"));
    process.exitCode = 1;
  } else {
    console.log("✓ 团队空间页可用（发码 / 入团 / 改角色 / 移除 / 账本，且账本真的落盘）");
  }
}
