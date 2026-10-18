#!/usr/bin/env node
/**
 * **SWE-bench 环境一键准备**（E03，2026-10-18）。
 *
 * 这一轮是手搓出来的：装 Docker → 用 uv 装 Python 3.11 → 装 `swebench` →
 * 下数据集（huggingface.co 在本机被 DNS 污染，得走镜像）→ **给官方 harness 打 CRLF 补丁**。
 * 手搓的问题不是慢，是**下次没人知道要打那个补丁** —— 而漏了它，一轮跑出来的
 * 是 0% 假成绩。所以把这一段收进仓库。
 *
 * ```bash
 * node scripts/swebench-setup.mjs            # 检查 + 准备（不动全局 Python）
 * node scripts/swebench-setup.mjs --check    # 只检查，不装任何东西
 * ```
 *
 * ## 它装在哪
 *
 * 全部落在 `--dir`（默认 `~/.ding-swebench`）下：一个独立的 Python 3.11 虚拟环境、
 * 数据集、预测与报告。**不碰系统 Python、不改全局配置**。
 *
 * ## 它不做什么
 *
 * 不跑模型、不判分、不写 BENCHMARKS。那些见 `bench/swebench/README.md`。
 *
 * ## 凭据
 *
 * 数据集实测是公开的（`gated=false`），不需要 HF token。
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const argv = process.argv.slice(2);
const flag = (name, fallback = "") => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const CHECK_ONLY = argv.includes("--check");
const DIR = path.resolve(flag("dir", path.join(os.homedir(), ".ding-swebench")));
const MIRROR = flag("mirror", "https://hf-mirror.com");
const PY_VERSION = flag("python", "3.11");
const PY = path.join(DIR, ".venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");

/** 一条检查结果。 */
const checks = [];
const report = (name, ok, detail, next = "") => {
  checks.push({ name, ok, detail, next });
  console.log(`${ok ? "✓" : "✗"} ${name}：${detail}`);
  if (!ok && next) console.log(`    下一步：${next}`);
};

/** 跑一条命令（Windows 上 `.cmd` 走 cmd.exe；其余直接 exec）。 */
function run(cmd, args, opts = {}) {
  const needsShell = process.platform === "win32" && /\.(cmd|bat)$/i.test(cmd);
  const [file, argv2] = needsShell ? ["cmd.exe", ["/d", "/s", "/c", cmd, ...args]] : [cmd, args];
  const got = spawnSync(file, argv2, { encoding: "utf8", ...opts });
  return { code: got.status ?? -1, out: `${got.stdout ?? ""}${got.stderr ?? ""}`.trim() };
}

/**
 * 找 `docker` 可执行文件。
 *
 * ⚠️ Windows 上 Docker Desktop 装完**不一定把 CLI 放进 PATH**：实测它落在
 * `%LOCALAPPDATA%\Programs\DockerDesktop\resources\bin\docker.exe`，而 `where docker`
 * 找不到。这一格以前是"照文档装完就说可用、脚本却跑不动"的典型，
 * 所以这里按常规路径再找一遍，找到就把所在目录加进本次进程的 PATH。
 */
function dockerCmd() {
  const direct = run("docker", ["version", "--format", "{{.Client.Version}}"], { timeout: 20_000 });
  if (direct.code === 0) return "docker";
  if (process.platform !== "win32") return "docker";
  const local = process.env.LOCALAPPDATA ?? "";
  const candidates = [
    local ? path.join(local, "Programs", "DockerDesktop", "resources", "bin", "docker.exe") : "",
    "C:\\Program Files\\Docker\\Docker\\resources\\bin\\docker.exe",
  ].filter(Boolean);
  for (const file of candidates) {
    if (existsSync(file)) {
      process.env.PATH = `${path.dirname(file)};${process.env.PATH ?? ""}`;
      return file;
    }
  }
  return "docker";
}

/* ── 1. Docker ── */
{
  const docker = dockerCmd();
  const got = run(docker, ["info", "--format", "{{.ServerVersion}}"], { timeout: 60_000 });
  if (got.code === 0) report("Docker 引擎", true, `可用（服务端 ${got.out.split("\n").pop()}）`);
  else {
    report(
      "Docker 引擎",
      false,
      got.out.slice(0, 160) || "docker 命令不可用",
      "装 Docker Desktop 并启动它（官方 harness 按仓库/版本起镜像，没有它无法判分）",
    );
  }
}

/* ── 2. uv（用来装独立 Python，不动系统那个） ── */
const uvVersion = (() => {
  const got = run("uv", ["--version"], { timeout: 30_000 });
  return got.code === 0 ? got.out.trim() : "";
})();
if (uvVersion) report("uv", true, uvVersion);
else report("uv", false, "没装", "装 uv（能把 Python 3.11 与依赖装进项目目录，不污染系统 Python）：https://docs.astral.sh/uv/");

if (!CHECK_ONLY && uvVersion) {
  mkdirSync(DIR, { recursive: true });
  const pyDir = path.join(DIR, "py");
  const env = { ...process.env, UV_PYTHON_INSTALL_DIR: pyDir };

  /* ── 3. 独立 Python ── */
  {
    const got = run("uv", ["python", "install", PY_VERSION], { env, timeout: 600_000 });
    report("Python " + PY_VERSION, got.code === 0, got.code === 0 ? `已就绪（${pyDir}）` : got.out.slice(-200));
  }

  /* ── 4. venv + swebench ── */
  {
    if (!existsSync(PY)) run("uv", ["venv", "--python", PY_VERSION, path.join(DIR, ".venv")], { env, timeout: 300_000 });
    const install = run("uv", ["pip", "install", "--python", PY, "swebench==3.0.5"], { timeout: 900_000 });
    const probe = run(PY, ["-c", "import swebench; print('ok')"]);
    report("swebench 3.0.5", install.code === 0 && probe.code === 0, probe.out.slice(0, 60) || install.out.slice(-160));
  }
}

/* ── 5. 数据集 ── */
if (!CHECK_ONLY) {
  const jsonl = path.join(DIR, "verified.jsonl");
  const rows = (() => {
    try {
      return readFileSync(jsonl, "utf8").split("\n").filter(Boolean).length;
    } catch {
      return 0;
    }
  })();
  if (rows >= 500) report("数据集", true, `${jsonl}（${rows} 条）`);
  else {
    report(
      "数据集",
      false,
      rows ? `只有 ${rows} 条（Verified 是 500 条）` : "还没有 verified.jsonl",
      `从镜像取一份 parquet 再转 JSONL：curl -L "${MIRROR}/datasets/princeton-nlp/SWE-bench_Verified/resolve/main/data/test-00000-of-00001.parquet" -o verified.parquet，` +
        "再用任意 parquet 读取器转成一行一条 JSON（字段照官方 JSONL）。数据集不进仓。",
    );
  }
}

/* ── 6. CRLF 补丁状态（最要紧的一格） ── */
if (!CHECK_ONLY && existsSync(PY)) {
  /*
   * 判据是**补丁里那句独有的话**（`_eval_lf`），不是"文件里有 write_bytes" ——
   * 后者在干净安装里也可能出现，会把没打补丁误判成已打（那就白跑了）。
   *
   * ⚠️ 还有一个陷阱：uv 的安装缓存用**硬链接**共享文件。如果你在 A 环境打过补丁，
   * 之后新建的 B 环境可能**指向同一份被改过的文件**（实测 inode 相同）。
   * 这既是好事（补丁跟着走）也是风险（改了上游文件而自己不知道）——
   * 所以要判就判文件内容，别假设"新环境一定是干净的"。
   */
  const probe = run(PY, [
    "-c",
    "import pathlib, swebench.harness.run_evaluation as m; s=pathlib.Path(m.__file__).read_text(encoding='utf-8'); print('PATCHED' if '_eval_lf' in s else 'NEEDS_PATCH')",
  ]);
  const patched = probe.out.includes("PATCHED");
  report(
    "评估脚本 LF 补丁",
    patched,
    patched ? "已打（eval.sh 会写成 LF）" : "**未打**",
    patched
      ? ""
      : "Windows 上不打这个补丁，官方 harness 会把 eval.sh 写成 CRLF，容器里的 bash 把 \\r 带进参数，" +
        "**每一版补丁都判不过**（实测跑出过 0/10 的假成绩）。改法见 bench/swebench/README.md「真跑一遍踩到的坑」第 1 条。",
  );
}

const failed = checks.filter((c) => !c.ok);
console.log("");
if (failed.length) {
  console.log(`⚠️ ${failed.length} 项没就绪（每条都写了下一步）。工作目录：${DIR}`);
  process.exitCode = 1;
} else {
  console.log(`✓ 全部就绪。工作目录：${DIR}`);
  console.log("  下一步：bench/swebench/README.md（生成预测 → 官方 harness 判分）");
}
