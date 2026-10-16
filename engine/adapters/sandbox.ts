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
 * `process.resourcesPath`（打包态的 `resources/` 目录）。
 *
 * ⚠️ 这个字段是 **Electron 独有**的，`@types/node` 里没有；而 `tsconfig.cli.json` 只带
 * `types: ["node"]` —— 同一份源码要供两个宿主编，CLI 那份就会在这里报
 * `Property 'resourcesPath' does not exist on type 'Process'`（2026-10-16 审计 G40/G95
 * 顺带撞到的：`pnpm cli:build` 当时根本编不过，因为这条 npm 产物此前**没有任何门在看**）。
 *
 * 取舍：**不能**为了 CLI 编得过就把这两行删掉 —— 桌面打包态真的靠它找沙箱（README 那句
 * "安装包带着 ding-sandbox.exe"就是这个）。所以做一次显式的、带说明的收窄，
 * 而不是 `any` 糊过去：非 Electron 环境下它就是 `undefined`，行为与原来一致。
 */
function resourcesPathOf(): string {
  const value = (process as NodeJS.Process & { resourcesPath?: unknown }).resourcesPath;
  return typeof value === "string" ? value : "";
}

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
  /*
   * ⚠️ **打包态那两条不能少**（2026-10-16 补）：
   *
   * 之前这里只看 `process.cwd()` —— 而装出来的应用 cwd 是"用户从哪儿启动的"，
   * 于是**安装包里就算带了沙箱也找不到**（README 那句 ✅ 与现实不符，主人正是这么发现的）。
   * 现在显式看两处打包位置：`extraResources` 落地的 `resources/`（`process.resourcesPath`），
   * 以及 exe 自己所在目录。dev 态那两条保持不动。
   */
  const candidates = [
    /* 打包态：`extraResources` 把 ding-sandbox 放在 resources/ 下（见 package.json 的 build） */
    ...(resourcesPathOf() ? [path.join(resourcesPathOf(), name)] : []),
    /* 打包态：与 exe 同级 */
    path.join(path.dirname(process.execPath), name),
    /* 开发态：cargo 的产物（`pnpm sandbox:build` 编到这儿） */
    path.join(process.cwd(), "sandbox", "target", "release", name),
    path.join(process.cwd(), "sandbox", "target", "debug", name),
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
   * `args` **原样**拼成命令行（`windowsVerbatimArguments`），一个字符都不让 Node 转义。
   * 直通路要它（理由见 `planFor`），沙箱路不要（那边的参数由 CRT 规则解析）。
   */
  verbatimArgv: boolean;
  /**
   * 额外要设的环境变量。
   *
   * ⚠️ 走沙箱时命令本身**走这里**而不是 argv（见下面 `planFor` 的说明）——
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
 * 给一条命令编排"怎么跑它"。**纯函数**：能力由调用方传进来（`planSandboxed` 负责去问）。
 *
 * 拆开是为了让两条路**都能被测到**：本机编过 `pnpm sandbox:build` 时走沙箱那条，
 * 没编过时走直通那条 —— 只看 `probeSandbox()` 的话，测到的永远只是本机这一条，
 * 另一条要等 CI 或用户机器上才第一次执行（那正是直通路的引号缺陷躲过整轮开发的原因）。
 *
 * @param command 用户/模型给的那条命令行
 * @param info 沙箱能力（`probeSandbox()` 的结果）
 * @param opts.memoryMb / processes 上限（省略用默认；测试要压小才快）
 * @returns 计划（`file` + `args`），调用方直接 spawn 它
 */
export function planFor(
  command: string,
  info: SandboxInfo,
  opts: {
    memoryMb?: number;
    processes?: number;
  } = {},
): SandboxPlan {
  const isWin = process.platform === "win32";
  const comSpec = isWin ? (process.env.ComSpec ?? "cmd.exe") : "/bin/sh";
  /*
   * ⚠️ 两条路的 shell 参数**不一样**，别图省事用同一份：
   *   · 直通那条：命令就在 argv 里（`cmd /d /s /c <命令>`）；
   *   · 沙箱那条：命令走环境变量（理由见下），所以这里**只能给固定旗标** ——
   *     把命令也留在 argv 里会让 cmd 收到两遍（第一版就是这么写的，
   *     报错长成 `Cannot find module 'C:\…\work\"…" node …'` 那种四不像）。
   */
  const shellFlags = isWin ? ["/d", "/s", "/c"] : ["-c"];

  if (!info.found) {
    /*
     * ⚠️ 直通路的引号：命令要**原样**落到 cmd 手里，Node 的转义一个都不许加。
     *
     * Node 在 Windows 上按 **CRT** 规则给每个 argv 元素加引号（`"` → `\"`），
     * 而 `cmd.exe` 不按 CRT 解析命令行 —— 于是 `node -e "…"`、带引号的路径
     * 这类**含引号的命令**到它手里会变形：实测**退出码 0、没有输出、什么都没跑**
     * （静默失效，界面上只看到"（没有输出）"）。2026-10-16 CI 第一次真跑单测时逮到，
     * 此前一直没露头，是因为开发机上编过沙箱、命令全走沙箱那条路。
     *
     * 所以这里做两件事：① 命令外面再套一层引号 —— cmd 的 `/s` 会剥掉它，
     * 里层的引号原样留下（命令自己以引号开头也不会被 `cmd` 剥错）；
     * ② `verbatimArgv: true`，让调用方关掉 Node 的转义。
     */
    return {
      file: comSpec,
      args: [...shellFlags, isWin ? `"${command}"` : command],
      verbatimArgv: isWin,
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
    /* 这条路的参数是给 CRT/sandbox 自己解析的（不是给 cmd 解析的），照常让 Node 转义 */
    verbatimArgv: false,
    env: { DING_SANDBOX_COMMAND: command },
    bounded: info.bounded,
    note: info.note,
  };
}

/**
 * 编排一条命令（先去问沙箱能力，再拼计划）。
 *
 * @param command 用户/模型给的那条命令行
 * @param opts 上限（省略用默认）
 * @returns 计划（`file` + `args`），调用方直接 spawn 它
 */
export function planSandboxed(
  command: string,
  opts: {
    memoryMb?: number;
    processes?: number;
  } = {},
): SandboxPlan {
  return planFor(command, probeSandbox(), opts);
}
