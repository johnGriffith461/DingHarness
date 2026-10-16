/**
 * A1 验收：`drive:rename` / `drive:read` 的路径校验 —— **改前接受越界路径 / 改后拒绝**。
 *
 * ## 为什么是"独立脚本 + 真文件系统"
 *
 * 主进程在本项目没有测试基础设施（`vitest.config.ts` 只收 `src/` 下的 `*.test.ts`），
 * 而那道校验原先是 `driveStore.ts` 里的一个私有函数 —— 后者顶层 `import` 了 `electron`，
 * 于是"限制被绕过"这件事**既没有断言、也没法在 Electron 之外复现**。
 *
 * 现在判断被抽到 `engine/runtime/tools/drivePaths.ts`（只依赖 `node:path`），
 * 所以这个脚本能拿着**生产里用的同一个函数**跑真文件系统：
 * 越界路径真的被拒、云盘里的文件真的还能改名（不是"读一遍源码看看有没有写校验"）。
 *
 * ⚠️ 全程只在一份 `mkdtemp` 出来的临时目录里动手，**不碰任何真实数据目录**。
 *
 * 跑法：`pnpm verify:drive-paths`（2026-10-16 起也挂在 `pnpm build` 链上 ——
 * 审计 G39 的原话是"没有任何自动化会跑它"，一条没人跑的验收等于没有）。
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { insideDirs } from "../engine/runtime/tools/drivePaths";

let failed = 0;

/** 一条断言：红了就记一次并打印。 */
function check(label: string, ok: boolean, extra = ""): void {
  if (ok) {
    console.log(`  ✓ ${label}${extra ? `  ${extra}` : ""}`);
  } else {
    failed += 1;
    console.log(`  ✗ ${label}${extra ? `  ${extra}` : ""}  ← 失败`);
  }
}

/* ─────────────────────── 改前的口径（逐字复刻旧实现） ─────────────────────── */

/**
 * 旧 `drive:rename` 的做法：**没有**任何目录校验，拿到路径直接解析、直接改。
 * 逐字抄在这里，是为了让"改前接受越界路径"这句结论有东西可跑，而不是一句回忆。
 */
async function legacyRename(rawPath: string, newName: string): Promise<string | null> {
  const clean = String(newName ?? "").trim();
  if (!clean || /[\\/]/.test(clean)) return null;
  try {
    const from = path.resolve(String(rawPath)); // ← 旧代码就是这一句，直接采用
    const dir = path.dirname(from);
    const to = path.join(dir, clean);
    await fs.rename(from, to);
    return clean;
  } catch {
    return null;
  }
}

/** 旧 `drive:read`：同样**没有**目录校验，路径直接用。 */
async function legacyRead(rawPath: string): Promise<string | null> {
  try {
    const stat = await fs.stat(String(rawPath));
    if (!stat.isFile() || stat.size > 200 * 1024) return null;
    return await fs.readFile(String(rawPath), "utf8");
  } catch {
    return null;
  }
}

/* ─────────────────────── 改后的口径（生产同款） ─────────────────────── */

const ownedDirs: string[] = [];

/** 新 `drive:rename`：先过 `insideOwnedDirs`，再要求源是普通文件。 */
async function guardedRename(rawPath: string, newName: string): Promise<string | null> {
  const clean = String(newName ?? "").trim();
  if (!clean || /[\\/]/.test(clean)) return null;
  const from = insideDirs(rawPath, ownedDirs);
  if (!from) return null;
  try {
    const stat = await fs.stat(from);
    if (!stat.isFile()) return null;
    const dir = path.dirname(from);
    const to = path.join(dir, clean);
    try {
      await fs.access(to);
      return null;
    } catch {
      /* 不存在才是正常的 */
    }
    await fs.rename(from, to);
    return clean;
  } catch {
    return null;
  }
}

/** 新 `drive:read`：先过 `insideOwnedDirs`，"超上限返回 null"原样保留。 */
async function guardedRead(rawPath: string): Promise<string | null> {
  const target = insideDirs(rawPath, ownedDirs);
  if (!target) return null;
  try {
    const stat = await fs.stat(target);
    if (!stat.isFile() || stat.size > 200 * 1024) return null;
    return await fs.readFile(target, "utf8");
  } catch {
    return null;
  }
}

/* ───────────────────────────────── 跑 ───────────────────────────────── */

async function main(): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "a1-drive-paths-"));
  const drive = path.join(root, "drive"); // 白名单目录（模拟 userData/drive）
  const outside = path.join(root, "outside"); // 白名单之外
  ownedDirs.push(drive);
  await fs.mkdir(drive, { recursive: true });
  await fs.mkdir(outside, { recursive: true });

  const insideFile = path.join(drive, "a.md");
  const outsideFile = path.join(outside, "secret.txt");
  await fs.writeFile(insideFile, "云盘里的内容", "utf8");
  await fs.writeFile(outsideFile, "云盘外面不该被读到的东西", "utf8");

  console.log(`临时夹具：${root}\n`);

  /* 1. 改前：越界路径被**接受** */
  console.log("【改前】旧实现（无校验）");
  const hacked = await legacyRename(outsideFile, "hacked.txt");
  check("drive:rename 接受了云盘外的路径", hacked === "hacked.txt", `→ 返回 ${JSON.stringify(hacked)}`);
  const movedTo = path.join(outside, "hacked.txt");
  const leaked = await legacyRead(movedTo);
  check("drive:read 读到了云盘外的文件", leaked === "云盘外面不该被读到的东西", `→ ${JSON.stringify(leaked)}`);
  // 复原，方便下一段对照
  await fs.rename(movedTo, outsideFile);

  /* 2. 改后：同一批路径被**拒绝** */
  console.log("\n【改后】生产同款（insideDirs + isFile）");
  const deniedRename = await guardedRename(outsideFile, "hacked-again.txt");
  check("drive:rename 拒绝了云盘外的路径", deniedRename === null, `→ 返回 ${JSON.stringify(deniedRename)}`);
  const stillThere = await fs
    .stat(outsideFile)
    .then(() => true)
    .catch(() => false);
  check("云盘外的文件**没有被改名**（真的没动，不是假装拒了）", stillThere);

  const deniedRead = await guardedRead(outsideFile);
  check("drive:read 拒绝了云盘外的路径", deniedRead === null, `→ 返回 ${JSON.stringify(deniedRead)}`);

  /* 3. 越界姿势不只一种 */
  console.log("\n【改后】别种越界姿势");
  const viaDotDot = path.join(drive, "..", "outside", "secret.txt");
  check("`..` 穿越被拒（drive/../outside/secret.txt）", (await guardedRead(viaDotDot)) === null);
  const driveRootItself = await guardedRename(drive, "renamed-drive");
  check("拒绝把**整个云盘目录**改名搬走", driveRootItself === null, `→ 返回 ${JSON.stringify(driveRootItself)}`);
  const driveRootStillThere = await fs
    .stat(drive)
    .then(() => true)
    .catch(() => false);
  check("云盘目录**仍在原位**", driveRootStillThere);

  /* 4. 正常功能没被误伤 —— 这条和上面几条一样重要 */
  console.log("\n【改后】正常流程不被误伤");
  const okRename = await guardedRename(insideFile, "b.md");
  check("云盘**里面**的文件照旧能改名", okRename === "b.md", `→ 返回 ${JSON.stringify(okRename)}`);
  const okRead = await guardedRead(path.join(drive, "b.md"));
  check("云盘**里面**的文件照旧能读", okRead === "云盘里的内容", `→ ${JSON.stringify(okRead)}`);
  await fs.writeFile(path.join(drive, "big.txt"), "x".repeat(200 * 1024 + 1), "utf8");
  check("超上限仍然返回 null（A1 明确要求保留的行为）", (await guardedRead(path.join(drive, "big.txt"))) === null);

  /* 5. 收尾 */
  await fs.rm(root, { recursive: true, force: true });
  console.log(`\n临时夹具已删除：${root}`);
  console.log(failed === 0 ? "\n结果：全部通过" : `\n结果：${failed} 条失败`);
  if (failed > 0) process.exitCode = 1;
}

await main();
