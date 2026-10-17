import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * **SDK 公开面的冻结门**（V5-4 任务 4.2）。
 *
 * ## 它挡的是什么
 *
 * `ding-engine-core` / `ding-engine` 一旦发出去，外部程序就按那份名字表写代码 ——
 * 内部重构顺手改掉一个导出名、或者把一个"值"改成"只剩类型"，在 diff 里看不出问题，
 * 而在使用者那边是**编译不过 / 运行时 undefined**。
 *
 * 所以把两份公开面做成**可计算的清单**（`packages/api.frozen.json`），在这里对账：
 *
 *   ① 代码里的导出 = 清单里的那一条（加了 / 删了 / 种类变了 → 红）；
 *   ② 每个条目都带 `since`（它从哪一版起存在）—— 版本是要能追溯的；
 *   ③ 两个包的版本与清单版本一致（`ding-engine` 依赖着 `ding-engine-core` 的具体版本，
 *      版本一漂，装的就不是同一份契约了）；
 *   ④ 发布流程文档在仓（`RELEASE.md`）且写着那三件必须写的事
 *      （ADR / major / 迁移指南）—— 4.2 的验收原文是"破坏性变更必须 ADR+major bump"，
 *      这一条保证那句话**有个落在仓里的出处**。
 *
 * 改了公开面怎么办：**加** = 补清单（minor）；**删或改签名** = 先加 ADR，再 major + 迁移指南。
 * 门不判断改动好坏，它只保证没有一次公开面变更是无名的。
 */

const ROOT = path.resolve(__dirname, "..");
const FROZEN = path.join(ROOT, "packages/api.frozen.json");

type FrozenExport = { name: string; kind: "type" | "value"; since: string };
type Frozen = {
  note: string;
  process: { additive: string; breaking: string };
  version: string;
  packages: Record<string, { entry: string; exports: FrozenExport[] }>;
};

const frozen = JSON.parse(readFileSync(FROZEN, "utf8")) as Frozen;

/**
 * 从公开面文件里算出**现在**的导出清单。
 *
 * 口径：`export { a, type B } from "…"`（公开面文件只许用这一种写法 ——
 * 它本身是声明，不是实现）。这条"只许一种写法"由下面第一条断言把住：
 * 算不出东西就说明写法变了，而不是"没有导出"。
 */
function surfaceOf(entry: string): FrozenExport[] {
  const source = readFileSync(path.join(ROOT, entry), "utf8");
  const out: FrozenExport[] = [];
  for (const block of source.matchAll(/export\s+(?:type\s+)?\{([\s\S]*?)\}\s*from/g)) {
    for (const raw of block[1]!.split(",")) {
      const item = raw.trim().replace(/\s+/g, " ");
      if (!item) continue;
      const isType = item.startsWith("type ");
      out.push({ name: (isType ? item.slice(5) : item).trim(), kind: isType ? "type" : "value", since: "" });
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

const asMap = (list: readonly FrozenExport[]): Map<string, string> => new Map(list.map((e) => [e.name, e.kind]));

describe("SDK 公开面冻结（V5-4 4.2）", () => {
  for (const [pkgName, surface] of Object.entries(frozen.packages)) {
    it(`${pkgName}：导出清单与冻结的一份逐条对齐`, () => {
      const now = surfaceOf(surface.entry);
      expect(now.length, `${surface.entry} 一个导出都没算出来 —— 公开面文件的写法变了？`).toBeGreaterThan(0);

      const want = asMap(surface.exports);
      const got = asMap(now);
      const added = [...got.keys()].filter((k) => !want.has(k));
      const removed = [...want.keys()].filter((k) => !got.has(k));
      const changed = [...got.keys()]
        .filter((k) => want.has(k) && want.get(k) !== got.get(k))
        .map((k) => `${k}：${want.get(k)} → ${got.get(k)}`);

      expect(
        added,
        `新增了公开导出（是加法的话，补进 packages/api.frozen.json 就绿；不是的话别导出它）：\n${added.join("\n")}`,
      ).toEqual([]);
      expect(
        removed,
        `删掉了公开导出（这是**破坏性变更**：先加 ADR，再 major + 迁移指南，然后才动清单）：\n${removed.join("\n")}`,
      ).toEqual([]);
      expect(changed, `导出的种类变了（值 ↔ 类型 同样是破坏性变更）：\n${changed.join("\n")}`).toEqual([]);
    });

    it(`${pkgName}：每个条目都记着"从哪一版起"`, () => {
      const noSince = surface.exports.filter((e) => !/^\d+\.\d+\.\d+$/.test(e.since));
      expect(noSince.map((e) => e.name)).toEqual([]);
    });
  }

  it("两个包的版本与清单一致（不然装的不是同一份契约）", () => {
    const versions = Object.keys(frozen.packages).map((pkg) => {
      const file = pkg === "ding-engine-core" ? "packages/engine-core/package.json" : "packages/engine/package.json";
      return { pkg, version: (JSON.parse(readFileSync(path.join(ROOT, file), "utf8")) as { version: string }).version };
    });
    for (const { pkg, version } of versions) {
      expect(version, `${pkg} 的版本与 packages/api.frozen.json 不一致`).toBe(frozen.version);
    }
  });

  it("发布流程文档在仓，且写着那三件必须写的事", () => {
    const doc = readFileSync(path.join(ROOT, "RELEASE.md"), "utf8");
    for (const must of ["ADR", "major", "迁移指南", "兼容窗口"]) {
      expect(doc, `RELEASE.md 里没有「${must}」（破坏性变更的流程必须有个落在仓里的出处）`).toContain(must);
    }
  });
});
