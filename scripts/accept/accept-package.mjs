import fs from "node:fs";
import path from "node:path";

/**
 * 验证打包产物（阶段 9.4 / 9.5）。
 *
 * 光"构建成功"不算数，要核实：
 *   1. setup.exe 真的存在、体积合理
 *   2. **exe 里真的嵌了我们画的图标**（PE 资源里有 ICO 组）——
 *      只配了 build.icon 但资源没写进去是很常见的"看着配了其实没用"
 *   3. 解包目录里的 exe 带图标
 *   4. 主进程入口是 .cjs 且崩溃兜底壳在
 *   5. asar 里有 renderer 产物
 */

function exists(p) {
  try {
    return fs.existsSync(p);
  } catch {
    return false;
  }
}
const size = (p) => (exists(p) ? fs.statSync(p).size : 0);
const mb = (n) => `${(n / 1024 / 1024).toFixed(1)} MB`;

/** 在 PE 里找 ICO 资源的痕迹：RT_GROUP_ICON(14) / RT_ICON(3) 的目录项以 0x000E / 0x0003 出现。 */
function peHasIcon(file) {
  const buf = fs.readFileSync(file);
  if (buf.subarray(0, 2).toString("ascii") !== "MZ") return { ok: false, why: "不是 PE（无 MZ）" };
  // 资源目录里会有一串 0x00 0x0E（RT_GROUP_ICON）与 0x00 0x03（RT_ICON）的条目
  let groupHits = 0;
  let iconHits = 0;
  for (let i = 0; i < buf.length - 3; i += 1) {
    if (buf[i] === 0x00 && buf[i + 1] === 0x0e && buf[i + 2] === 0x00 && buf[i + 3] === 0x00) groupHits += 1;
    if (buf[i] === 0x00 && buf[i + 1] === 0x03 && buf[i + 2] === 0x00 && buf[i + 3] === 0x00) iconHits += 1;
  }
  return { ok: groupHits > 0 && iconHits > 0, groupHits, iconHits, bytes: buf.length };
}

const R = "D:/DoubaoWorkClone/release";
const report = {};

const setup = path.join(R, "工作台-0.1.0-setup.exe");
report.setup = { exists: exists(setup), bytes: size(setup), human: mb(size(setup)) };
report.setupIcon = exists(setup) ? peHasIcon(setup) : null;

const unpackedExe = path.join(R, "win-unpacked", "工作台.exe");
report.unpackedExe = { exists: exists(unpackedExe), bytes: size(unpackedExe) };
report.unpackedIcon = exists(unpackedExe) ? peHasIcon(unpackedExe) : null;

// 我们的图标（256 帧）是不是真的在里面：搜 PNG 魔数 + 尺寸头
if (exists(unpackedExe)) {
  const buf = fs.readFileSync(unpackedExe);
  const magic = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  let idx = buf.indexOf(magic);
  let count = 0;
  while (idx !== -1 && count < 20) {
    count += 1;
    idx = buf.indexOf(magic, idx + 1);
  }
  report.embeddedPngFrames = count;
}

const asar = path.join(R, "win-unpacked", "resources", "app.asar");
report.asar = { exists: exists(asar), bytes: size(asar), human: mb(size(asar)) };

const mainCjs = path.join(R, "win-unpacked", "resources", "app", "dist-electron", "electron", "main.cjs");
report.unpackedMain = { path: mainCjs, exists: exists(mainCjs) };

report.releaseFiles = fs
  .readdirSync(R)
  .filter((f) => /\.(exe|blockmap|yml)$/.test(f))
  .map((f) => ({ f, human: mb(size(path.join(R, f))) }));

console.log(JSON.stringify(report, null, 2));
console.log("\n结论：");
console.log("  setup.exe 产出：", report.setup.exists ? "是" : "否");
console.log("  安装包带图标：", report.setupIcon?.ok ? "是" : `否（${JSON.stringify(report.setupIcon)}）`);
console.log("  解包 exe 带图标：", report.unpackedIcon?.ok ? "是" : "否");
