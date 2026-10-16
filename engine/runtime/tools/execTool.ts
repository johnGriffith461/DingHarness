import { spawn, spawnSync } from "node:child_process";
import path from "node:path";

import { insideDirs } from "./drivePaths";
import { planSandboxed } from "../../adapters/sandbox";

/**
 * 「跑命令」工具的执行体（2026-10-14）。
 *
 * ## 为什么要有它（这是"agent 真能干活的"分水岭）
 *
 * 在此之前这个 agent 只会读写文件 —— 它**没法执行任何东西**：
 * 装不了依赖、跑不了测试、看一眼环境都不行。参考实现里这是最基础的一件工具
 * （opencode 的 `bash` / Cline 的 `execute_command` / goose 的 developer 扩展都是它），
 * 而它的存在与否，直接决定"agent 能干活"还是"agent 只能聊天"。
 *
 * ## 口径（照 opencode 的 `tool/plugin/shell.ts` 抄的参数，逐条注明）
 *
 * - **前台默认超时 2 分钟**（opencode `DEFAULT_TIMEOUT_MS = 2 * 60 * 1000`）；
 *   传 `timeout: 0` 表示不限时（长任务用）；
 * - **输出上限 2000 行 / 50 KiB，超了留**尾部**并注明截掉多少
 *   （opencode `MAX_LINES = 2_000` / `MAX_BYTES = 50 * 1024`，也是留尾部：
 *   `lines.slice(-maxLines)`）—— 命令的"最后几行"通常才是结论（测试结果、报错）；
 * - **工作目录必须在被授权的目录里**，越界直接拒绝（这一条是我们自己的，
 *   opencode 那边没有沙箱、以进程自身权限跑）。
 *
 * ## ⚠️ 如实说清这个工具的边界（别把没有的东西说成有）
 *
 * 它**就是**把 shell 交出去：能做用户能做的一切（含删文件、装东西、联网）。
 * 我们**没有**做（也做不了）真正的沙箱 —— Electron 主进程与渲染进程同权限
 * （`sandbox: false`）。所以防护只有三道，都不是万能的：
 *   ① **闸门**：`shared/permissions.ts` 里声明为 `write`，「按需确认」档下**执行前**拦下；
 *   ② **审批卡片上显示命令原文**（`toolArgsSummary`）——用户批之前看得见要跑什么；
 *   ③ **工作目录限制**：只能在授权目录里启动，不能靠 `cd` 跑到别处去（`cd` 在命令里也拦不到
 *      —— 这点也是如实：能 `cd ..` 出来。限制的是**起点**，不是终点）。
 *
 * 所以这条工具的定位是"把活儿干完的必需品"，不是"安全的能力"。真正的隔离要靠
 * 系统级手段（容器/低权用户），那是本项目之外的事 —— 本机版明确不做假沙箱。
 */

/** 前台命令默认超时（毫秒）——与 opencode 同值：2 分钟。 */
export const COMMAND_DEFAULT_TIMEOUT_MS = 2 * 60 * 1000;

/** 超时上限：再长就不该用这个工具（长任务该在后台/定时任务里跑）。 */
export const COMMAND_MAX_TIMEOUT_MS = 30 * 60 * 1000;

/** 输出上限：行数与字节数（opencode 同值）。 */
export const COMMAND_MAX_OUTPUT_LINES = 2_000;
export const COMMAND_MAX_OUTPUT_BYTES = 50 * 1024;

/**
 * 边跑边留在内存里的**尾部上限**（2026-10-16，审计 P43）。
 *
 * 原来是 `out += chunk` 一直累加、结束时才 `clampOutput` 裁一次 ——
 * 一条 `yes`、一个狂打日志的构建，就能在"裁剪"发生之前把主进程内存吃到一个 GB。
 * 这里边收边丢**最前面**的（结论通常在尾部，与 `clampOutput` 的取舍一致），
 * 丢了多少字节如实记账。
 */
export const COMMAND_STREAM_KEEP_BYTES = 256 * 1024;

/**
 * 只保尾部的一段字节缓冲。
 *
 * `push` 是热路径（stdout 每来一块就调一次），所以按块存、只在超出上限时丢头，
 * 不做每块的字符串拼接。
 */
export class TailBuffer {
  private chunks: Buffer[] = [];
  private size = 0;
  /** 累计进来的总字节（含后来被丢掉的）。 */
  total = 0;

  constructor(private readonly keep: number) {}

  push(chunk: Buffer): void {
    this.total += chunk.length;
    this.chunks.push(chunk);
    this.size += chunk.length;
    while (this.size > this.keep && this.chunks.length > 1) {
      this.size -= this.chunks.shift()!.length;
    }
  }

  /** 被丢掉的字节数（0 = 一个字节都没丢）。 */
  get dropped(): number {
    return this.total - this.size;
  }

  /** 剩下的尾部文本（从字节中间开头会出乱码 —— 与 `clampOutput` 同一个处理）。 */
  text(): string {
    const buf = this.chunks.length === 1 ? this.chunks[0]! : Buffer.concat(this.chunks);
    return buf.toString("utf8").replace(/^�*/, "");
  }
}

/** 跑一条命令的结果。 */
export type RunCommandResult =
  | {
      ok: true;
      command: string;
      cwd: string;
      exitCode: number | null;
      output: string;
      truncated: boolean;
      timedOut: boolean;
      /**
       * 这一条命令有没有真的在沙箱里跑（Phase 14.1）。
       *
       * ⚠️ **必须如实带出来**：没有隔离时用户/模型要能看见 ——
       * "以为有隔离"比"知道没有"更危险（后者至少会让人谨慎）。
       */
      sandboxed: boolean;
    }
  | { ok: false; error: string };

/** 把输出裁到上限（留**尾部**，并注明截掉了多少）。 */
function clampOutput(raw: string): { output: string; truncated: boolean } {
  const byLines = raw.split("\n");
  let lines = byLines;
  let truncated = false;
  if (lines.length > COMMAND_MAX_OUTPUT_LINES) {
    truncated = true;
    lines = lines.slice(-COMMAND_MAX_OUTPUT_LINES);
  }
  let text = lines.join("\n");
  if (Buffer.byteLength(text, "utf8") > COMMAND_MAX_OUTPUT_BYTES) {
    truncated = true;
    /* 按字节裁也要留尾部：从前面切，直到剩下的够小 */
    let buf = Buffer.from(text, "utf8").subarray(-COMMAND_MAX_OUTPUT_BYTES);
    /* 从字符中间切开会出现乱码 —— 往后挪到第一个完整字符处 */
    text = buf.toString("utf8").replace(/^\uFFFD*/, "");
  }
  return { output: text, truncated };
}

/**
 * 跑一条命令。
 *
 * @param input 命令与可选的工作目录 / 超时
 * @param dirs 允许在其中启动命令的目录白名单（绝对路径）
 * @param spawnImpl 注入点（单测里换成假的；默认真的 `spawn`）
 * @returns 输出与退出码；拒绝了给能照着做的理由
 */
export async function runCommandForModel(
  input: { command: string; workdir?: string; timeout?: number },
  dirs: readonly string[],
  spawnImpl: typeof spawn = spawn,
): Promise<RunCommandResult> {
  const command = String(input.command ?? "").trim();
  if (!command) return { ok: false, error: "命令是空的" };

  /*
   * 起点必须在授权目录里。没给 `workdir` 时用**第一个**可写目录 ——
   * 与「写文件」只给文件名时落云盘根是同一个口径（模型不知道绝对路径）。
   */
  const wanted = String(input.workdir ?? "").trim() || dirs[0] || "";
  const cwd = wanted ? insideDirs(wanted, dirs) : null;
  if (!cwd) {
    return { ok: false, error: "这个工作目录不在授权范围内（只能在你授权的目录里跑命令）" };
  }

  const asked = typeof input.timeout === "number" ? input.timeout : COMMAND_DEFAULT_TIMEOUT_MS;
  const timeout = asked === 0 ? 0 : Math.min(Math.max(asked, 1_000), COMMAND_MAX_TIMEOUT_MS);

  return await new Promise<RunCommandResult>((resolve) => {
    let child;
    /** 这一条命令有没有真的在沙箱里跑（如实报给模型与用户）。 */
    let sandboxed = false;
    try {
      /*
       * ⭐ **经沙箱执行**（Phase 14.1）：命令放进一个有内存/子进程上限的作业对象里跑，
       * 并且随沙箱一起结束（不留孤儿）。找不到沙箱就直通 —— 但那时 `sandboxed` 会是 false，
       * 由调用方如实转述（**静默降级比报错更坏**：用户会以为有隔离）。
       *
       * ⚠️ 走沙箱时 **`shell` 不用 Node 的**：那层壳会落在作业对象外面，
       * 于是上限约束的是壳、真正的命令在壳外跑（见 `sandbox.ts` 的说明）。
       */
      const plan = planSandboxed(command);
      sandboxed = plan.bounded;
      child = spawnImpl(plan.file, plan.args, {
        cwd,
        shell: false,
        windowsHide: true,
        /*
         * ⚠️ 直通路要**原样**把命令行交给 cmd：Node 的 CRT 转义会把命令里的引号弄坏，
         * 实测表现是"退出码 0、没有输出、什么都没跑"（见 `planFor` 的说明）。
         */
        windowsVerbatimArguments: plan.verbatimArgv,
        env: { ...process.env, ...plan.env },
      });
    } catch (e) {
      resolve({ ok: false, error: `起不来：${e instanceof Error ? e.message : String(e)}` });
      return;
    }

    const out = new TailBuffer(COMMAND_STREAM_KEEP_BYTES);
    let timedOut = false;
    let settled = false;

    /* stdout 与 stderr 合成一份：终端里看到的就是合在一起的（opencode 走 PTY 同理） */
    child.stdout?.on("data", (d: Buffer) => out.push(d));
    child.stderr?.on("data", (d: Buffer) => out.push(d));

    const timer =
      timeout > 0
        ? setTimeout(() => {
            timedOut = true;
            killTree(child);
          }, timeout)
        : null;

    const finish = (exitCode: number | null, errText?: string) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      const clamped = clampOutput(out.text());
      const truncated = clamped.truncated || out.dropped > 0;
      const output = clamped.output;
      const notes: string[] = [];
      if (truncated) notes.push(`（输出过长，只留了最后 ${COMMAND_MAX_OUTPUT_LINES} 行 / ${Math.round(COMMAND_MAX_OUTPUT_BYTES / 1024)}KB）`);
      if (timedOut) {
        notes.push(
          `（超过 ${timeout} ms 没结束，已中止 —— 如果这条命令本来就慢，把 timeout 调大些）`,
        );
      }
      if (errText) notes.push(`（${errText}）`);
      if (!output.trim() && !notes.length) notes.push("（没有输出）");
      resolve({
        ok: true,
        command,
        cwd,
        exitCode,
        output: [output.trimEnd(), ...notes].filter(Boolean).join("\n"),
        truncated,
        timedOut,
        sandboxed,
      });
    };

    child.on("error", (e) => finish(null, `起不来：${e.message}`));
    /* close 而不是 exit：要等 stdio 也读完，否则大输出会被截断在最后一口气上 */
    child.on("close", (code) => finish(code));
  });
}

/**
 * 把一个进程**连同它的子进程**杀掉。
 *
 * ⚠️ 这台机器是 Windows：`child.kill()` 只杀 `cmd.exe`，
 * 它下面的孙进程会活着继续跑（超时"杀掉了"其实没杀掉，是最难发现的那类假象）。
 * 所以 Windows 上走 `taskkill /T`；POSIX 上 kill 进程组意义不大，直接 SIGKILL。
 */
function killTree(child: ReturnType<typeof spawn>): void {
  const pid = child.pid;
  if (!pid) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/F", "/T", "/PID", String(pid)], { stdio: "ignore" });
    return;
  }
  try {
    child.kill("SIGKILL");
  } catch {
    /* 已经没了就算了 */
  }
}

/**
 * 把结果说成**一句话**（界面留痕与回给模型的共用这一句）。
 *
 * @param result 上面的结果
 * @returns 一句话
 */
export function describeRunResult(result: RunCommandResult, rawCommand: string): string {
  if (!result.ok) return `跑不了「${rawCommand}」：${result.error}`;
  const cmd = result.command.length > 60 ? `${result.command.slice(0, 60)}…` : result.command;
  const how = result.timedOut ? "超时中止" : `退出码 ${result.exitCode ?? "?"}`;
  return `跑了「${cmd}」（${how}）`;
}

/** 命令的**工作目录**也可以只给相对名（与写文件同口径）。供测试与调用方用。 */
export function defaultWorkdir(dirs: readonly string[]): string | null {
  return dirs.length ? path.resolve(dirs[0]) : null;
}
