import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * `electron/main.ts` 的**数据安全写法守卫**。
 *
 * 这个文件起不了应用（要 Electron），而它恰好挂着两件"会静默改坏你资料"的事，
 * 所以按本仓已有的做法用**源码断言**钉住（与 `src/windowChrome.test.ts` 同一路数）：
 *
 * | 条 | 要钉住的性质 |
 * |---|---|
 * | P33 / D6 | 更名迁移**两代老名字都认**（`工作台` + `Dingwork`），且判据是"新目录里有没有我们的数据"而不是"新目录存不存在" |
 * | D6 | 迁移是**合并不覆盖**的（`errorOnExist: false`） |
 * | P142 | `before-quit` 里**关掉数据库句柄**（KV + 会话库），不是只 `stopAllMcp()` |
 */

const MAIN = fs.readFileSync(path.join(__dirname, "..", "electron", "main.ts"), "utf8");

describe("electron/main.ts 的数据安全写法守卫", () => {
  it("D6：更名迁移认**两代**老名字（工作台 / Dingwork）", () => {
    const decl = /const LEGACY_PRODUCT_DIRS = \[([^\]]*)\]/.exec(MAIN);
    expect(decl, "找不到 LEGACY_PRODUCT_DIRS —— 迁移名单改形状了，守卫也要跟着改").toBeTruthy();
    const list = decl![1];
    expect(list).toContain('"Dingwork"');
    expect(list, "第一代名字（工作台）没认 —— 那一代用户升级上来会看到数据全没了").toContain("工作台");
    // 名字要被真的用起来（不是列了个数组就完事）
    expect(MAIN).toContain("for (const name of LEGACY_PRODUCT_DIRS)");
  });

  it("D6：判据是「新目录里有没有我们的数据」，不是「新目录存不存在」", () => {
    // Electron 启动早期就把 userData 建出来了 → 旧判据恒为 false，迁移退化成空操作
    expect(MAIN, "又用「新目录不存在」当迁移前置条件了 —— 那是永远不成立的空操作").not.toContain("!fs.existsSync(next)");
    expect(MAIN).toContain("function hasOurData");
    expect(MAIN).toContain("if (hasOurData(next)) return;");
    // 迁移只在打包态做（开发态的数据目录与身份无关）
    expect(MAIN).toContain("if (!app.isPackaged) return;");
  });

  it("D6：迁移是合并不覆盖（不拿旧目录盖掉用户已经在新版里写下的东西）", () => {
    expect(MAIN).toContain("force: false");
    expect(MAIN).toContain("errorOnExist: false");
  });

  it("P142：before-quit 里关掉 KV 与会话库句柄", () => {
    const handler = /app\.on\("before-quit",[\s\S]*?\n\}\);/.exec(MAIN);
    expect(handler, "找不到 before-quit handler").toBeTruthy();
    const body = handler![0];
    expect(body, "before-quit 里没关 KV 句柄（stores.db 一直锁着 → 与 ding backup/restore 抢库）").toContain("closeKv()");
    expect(body, "before-quit 里没关会话库句柄（Windows 上数据目录删不掉）").toContain("desktopSessionStore().close()");
    expect(body).toContain("stopAllMcp()");
  });
});
