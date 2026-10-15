import { existsSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

/**
 * 沙箱（Phase 14.1）的**宿主侧接线**。
 *
 * ## 这一层做什么
 *
 * `run_command` 要跑的命令，经 `ding-sandbox` 那个独立进程执行 —— 于是它有：
 *   · 内存上限（超过就死）、子进程数上限（挡 fork 炸弹）；
 *   · **随沙箱一起死**（命令起的那堆子进程不会留下当孤儿）。
 *
 * ## 这一层**不**做什么（重要，别把它当安全边界）
 *
 * 命令仍以**当前用户身份**运行：能读你的文件、能联网、能改能删。
 * 挡住的是"失控"，不是"恶意"。Windows 之外目前只是直通（没有 seccomp/seatbelt）。
 * 这些话在 `SAFETY.md` 与 `ding doctor` 里都如实写着 —— 代码注释与文档必须是同一件事。
 *
 * ## 什么时候走沙箱
 *
 * 找到 `ding-sandbox` 就用它；找不到就直通，**并让调用方知道**（返回 `bounded: false`）——
 * 静默降级比报错更坏：用户会以为有隔离。
 */

/** 沙箱能力。 */
export type SandboxInfo = {
  /** 找到二进制了吗。 */
  found: boolean;
  /** 真的有限制吗（`found` 且本平台有实现）。 */
  bounded: boolean;
  /** 二进制路径（找不到时为空串）。 */
  binary: string;
  /** 本平台的名字（写进 doctor / 日志）。 */
  platform: string;
  /** 找不到的原因（给用户看的一句话）。 */
  note: string;
};

/**
 * 找 `ding-sandbox`。
 *
 * 顺序：显式配置（`DING_SANDBOX`）→ 仓库里的构建产物 → PATH。
 * 显式配置排第一：验收与打包产物要能指定一个确定的路径（PATH 上那份可能是旧的）。
 */
export function findSandboxBinary(): string {
  const configured = process.env.DING_SANDBOX?.trim();
  if (configured && existsSync(configured)) return configured;

  const name = process.platform === "win32" ? "ding-sandbox.exe" : "ding-sandbox";
  const candidates = [
    /* 开发态：cargo 的产物（`pnpm sandbox:build` 编到这儿） */
    path.join(process.cwd(), "sandbox", "target", "release", name),
    path.join(process.cwd(), "sandbox", "target", "debug", name),
    /* 打包态：与 exe / 仓库同级 */
    path.join(process.cwd(), name),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return "";
}

/** 问一次能力（跑 `--probe`）。**不缓存** —— 用户可能刚编出来就重跑 doctor。 */
export function probeSandbox(): SandboxInfo {
  const binary = findSandboxBinary();
  if (!binary) {
    return {
      found: false,
      bounded: false,
      binary: "",
      platform: process.platform,
      note: "没有 ding-sandbox（编它：pnpm sandbox:build）；命令将不受限地跑",
    };
  }
  const got = spawnSync(binary, ["--probe"], { encoding: "utf8", timeout: 10_000 });
  const out = (got.stdout ?? "").trim();
  try {
    const parsed = JSON.parse(out) as { bounded?: boolean; platform?: string };
    const bounded = parsed.bounded === true;
    return {
      found: true,
      bounded,
      binary,
      platform: parsed.platform ?? process.platform,
      note: bounded
        ? "命令在作业对象里跑：有内存与子进程数上限，且随沙箱一起结束（不留孤儿）"
        : `本平台（${parsed.platform ?? process.platform}）还没有隔离实现，命令只是直通`,
    };
  } catch {
    return {
      found: true,
      bounded: false,
      binary,
      platform: process.platform,
      note: `ding-sandbox 答不出能力（输出：${out.slice(0, 60) || "（空）"}）`,
    };
  }
}

/** 编排好的命令行（跑一条命令所需的一切）。 */
export type SandboxPlan = {
  /** 实际要 spawn 的可执行文件。 */
  file: string;
  /** 它的参数。 */
  args: string[];
  /** 有没有隔离（`false` = 直通；调用方应当如实转述）。 */
  bounded: boolean;
  /**
   * 额外要设的环境变量。
   *
   * ⚠️ 命令本身**走这里**而不是 argv（见下面 `planSandboxed` 的说明）——
   * Windows 上 `cmd.exe` 要的是一整条原始命令行，argv 传过去会被引号转义规则弄坏。
   */
  env: Record<string, string>;
  /** 一句话说明（写进日志/回注，让用户知道这条命令是不是受限的）。 */
  note: string;
};

/** 默认上限（与 Rust 那边的默认一致；这里显式给出，因为 `run_command` 的输入里没这两项）。 */
export const SANDBOX_MEMORY_MB = 2048;
export const SANDBOX_PROCESSES = 32;

/**
 * 给一条命令编排"怎么跑它"。
 *
 * @param command 用户/模型给的那条命令行
 * @param opts.comSpec 平台 shell（Windows 用 ComSpec，POSIX 用 /bin/sh）
 * @param opts.memoryMb / processes 上限（省略用默认；测试要压小才快）
 * @returns 计划（`file` + `args`），调用方直接 spawn 它
 */
export function planSandboxed(
  command: string,
  opts: {
    memoryMb?: number;
    processes?: number;
  } = {},
): SandboxPlan {
  const info = probeSandbox();
  const comSpec = process.platform === "win32" ? (process.env.ComSpec ?? "cmd.exe") : "/bin/sh";
  /*
   * ⚠️ 两条路的 shell 参数**不一样**，别图省事用同一份：
   *   · 直通那条：命令就在 argv 里（`cmd /d /s /c <命令>`）；
   *   · 沙箱那条：命令走环境变量（理由见下），所以这里**只能给固定旗标** ——
   *     把命令也留在 argv 里会让 cmd 收到两遍（第一版就是这么写的，
   *     报错长成 `Cannot find module 'C:\…\work\"…" node …'` 那种四不像）。
   */
  const shellFlags = process.platform === "win32" ? ["/d", "/s", "/c"] : ["-c"];

  if (!info.found) {
    return {
      file: comSpec,
      args: [...shellFlags, command],
      env: {},
      bounded: false,
      note: "没有沙箱（命令不受限）——编它：pnpm sandbox:build",
    };
  }
  return {
    /*
     * ⚠️ 走沙箱时**自己拼 shell**：`spawn(..., {shell:true})` 会让 Node 在**外面**再套一层 shell，
     * 那层壳不在作业对象里 —— 于是"上限"约束的是壳、真正的命令在壳外面跑。
     * 所以 shell 作为沙箱的参数显式给出，而**命令本身走环境变量**：
     *
     *   命令行从 Node 传到沙箱要过两次 CRT 引号转义，而 `cmd.exe` 不按 argv 解析
     *   （它要一整条原始命令行）—— 含引号的命令（`node -e "…"`）到 cmd 手里会变形，
     *   实测表现是**静默无输出**或"系统找不到指定的路径"。
     *   环境变量没有这层转义，沙箱那边用 `raw_arg` 原样交给 cmd，
     *   效果与"在终端里手敲一遍"一致。
     */
    file: info.binary,
    args: [
      "--memory-mb",
      String(opts.memoryMb ?? SANDBOX_MEMORY_MB),
      "--processes",
      String(opts.processes ?? SANDBOX_PROCESSES),
      "--from-env",
      "--",
      comSpec,
      ...shellFlags,
    ],
    env: { DING_SANDBOX_COMMAND: command },
    bounded: info.bounded,
    note: info.note,
  };
}
