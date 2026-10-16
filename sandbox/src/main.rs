//! `ding-sandbox` —— 命令执行的**有界**进程（Phase 14.1）。
//!
//! ## 它做什么
//!
//! 把 `run_command` 要跑的命令放进一个**有资源上限的作业对象**里跑：
//!   · 内存上限（超过就杀）；
//!   · 子进程数上限（挡住 fork 炸弹）；
//!   · **随沙箱一起死**（沙箱退出时，作业里的所有进程都被终止）。
//!
//! ## 它不做什么（**如实写在这里，因为这就是 SAFETY.md 的事实来源**）
//!
//! · **不是安全边界**：命令仍以当前用户身份运行、仍能读你的文件、仍能联网。
//!   它挡的是"失控"（吃光内存、起无数子进程、留下孤儿进程），不是"恶意"。
//! · **Linux 的 seccomp / macOS 的 seatbelt 还没有**：代码里给那两个平台留的是直通执行
//!   （`bounded_available()` 为 false 那一支），但**那条路今天到不了**（2026-10-16 审计
//!   P112 的实地复核）：`win.rs` 第一行就 `use std::os::windows::process::CommandExt`，
//!   那是 Windows 专有的模块，而原先 `mod win;` 是无条件声明的 —— 整个 crate 在
//!   Linux/macOS 上过不了编译，压根编不出那个二进制。现在 `mod win` 按
//!   `#[cfg(target_os = "windows")]` 隔开了，非 Windows 那一支才第一次真的能被编到
//!   （⚠️ 这一半**没在本机验证过**：这台机器只有 Windows target，没有交叉工具链）。
//! · 命令本身仍然看得见 `$PATH` 与当前环境（脱敏环境变量是另一件事）。

#[cfg(target_os = "windows")]
mod win;

use std::process::ExitCode;

/// 默认上限（可用命令行参数覆盖）。
const DEFAULT_MEMORY_MB: u64 = 2048;
const DEFAULT_PROCESSES: u32 = 32;

struct Args {
    memory_mb: u64,
    processes: u32,
    /// 剩余的都当命令（第一个非选项参数起）。
    command: Vec<String>,
    /// 命令来自环境变量 `DING_SANDBOX_COMMAND`（为什么要走环境变量：见下面 `--from-env` 那一支）。
    from_env: bool,
}

/// 上限值的校验：**0 一律拒**（2026-10-16，审计 P122）。
///
/// ⚠️ 为什么 0 不是「没有上限」而是必须拒掉（本机实测，不是推断）：
/// 作业对象那两个字段带上限标志时，0 是个**硬顶/非法值**，实测结果是把整条约束废掉 ——
///   · `--memory-mb 0` → `SetInformationJobObject` 当场失败（错误码 87 = 参数无效）；
///   · `--processes 0` → 作业建起来了，但 `AssignProcessToJobObject` 失败（错误码 1816）。
/// 两条路都落到「命令照跑、**不受限**」的兜底上（实测两条命令都正常输出、退出码 0），
/// 而调用方以为自己设了个上限 —— 与 P115「`bounded` 不是执行事实」是同一个坑的入口。
/// 所以 0 按**用法错误**拒掉（退出码 2），不去猜用户想表达什么。
fn check_limit(label: &str, n: u64) -> Result<(), String> {
    if n == 0 {
        return Err(format!(
            "{label} 不能是 0：0 在作业对象里不是「没有上限」，而是让约束失效（实测：内存 0 → 上限设不上，进程 0 → 命令进不了作业，两条都变成不受限地跑）"
        ));
    }
    Ok(())
}

fn parse_args(argv: Vec<String>) -> Result<Args, String> {
    let mut memory_mb = DEFAULT_MEMORY_MB;
    let mut processes = DEFAULT_PROCESSES;
    let mut command: Vec<String> = Vec::new();
    let mut from_env = false;
    let mut it = argv.into_iter().skip(1);
    while let Some(a) = it.next() {
        match a.as_str() {
            "--memory-mb" => {
                let v = it.next().ok_or("--memory-mb 后面要给一个数")?;
                let n: u64 = v.parse().map_err(|_| format!("--memory-mb 不是数字：{v}"))?;
                check_limit("--memory-mb", n)?;
                memory_mb = n;
            }
            "--processes" => {
                let v = it.next().ok_or("--processes 后面要给一个数")?;
                let n: u32 = v.parse().map_err(|_| format!("--processes 不是数字：{v}"))?;
                check_limit("--processes", n as u64)?;
                processes = n;
            }
            /*
             * `--from-env`：命令从 `DING_SANDBOX_COMMAND` 读。
             *
             * ⚠️ **为什么要有这一条**（2026-10-15 实测踩出来的）：
             * `cmd.exe` 不按 argv 解析，它要的是**一整条原始命令行**。而命令从 Node 传到这儿
             * 已经过两次 CRT 转义规则的折腾 —— 含引号的命令（`node -e "…"` 这种）
             * 到 cmd 手里就变形了（实测：静默无输出、或"系统找不到指定的路径"）。
             * 环境变量没有这层转义，配合 `CommandExt::raw_arg` 原样交给 cmd，
             * 效果与"在终端里手敲一遍"一致。
             */
            "--from-env" => {
                from_env = true;
            }
            "--" => {
                command.extend(it);
                break;
            }
            other => {
                // 第一个非选项参数起，剩下的都当命令（不再解析选项 ——
                // 命令自己可能带 --foo，抢过来解析是错的）
                command.push(other.to_string());
                command.extend(it);
                break;
            }
        }
    }
    if command.is_empty() {
        return Err("用法：ding-sandbox [--memory-mb N] [--processes N] [--from-env] -- <命令> [参数…]".into());
    }
    Ok(Args { memory_mb, processes, command, from_env })
}

/// 命令行上是不是在**问能力**（`--probe`）。
///
/// ⚠️ 只在**第一个 `--` 之前**看（2026-10-16，审计 P121）：用法是
/// `ding-sandbox [选项] -- <命令> [参数…]`，`--` 之后的一律是**命令自己的参数**。
/// 原先在整个 argv 上 `any(|a| a == "--probe")`，于是
/// `ding-sandbox -- mytool --probe` 只打印一段 JSON 就返回 0，`mytool` 一次都没跑，
/// 而上层按退出码 0 判成功 —— 「命令没跑」被报成「跑成功了」。
fn wants_probe(argv: &[String]) -> bool {
    argv.iter()
        .skip(1)
        .take_while(|a| a.as_str() != "--")
        .any(|a| a == "--probe")
}

/// 本平台有没有真的"有界"实现（命令行上的 `--probe` 用它，doctor 也问它）。
///
/// ⚠️ 「本平台有这个实现」不等于「这条命令真的进了作业」（2026-10-16，审计 P115）：
/// 这个答案会经 `ding-sandbox --probe` 报给宿主侧（`engine/adapters/sandbox.ts` 的
/// `probeSandbox` → `bounded`），而它原来只回显 `cfg!(target_os = "windows")` ——
/// 一个**平台常量**，连作业都建不出来的机器（受限容器、被策略拦下的会话）也答 true。
/// 现在 Windows 上会**真的试着建一次作业对象并把上限设上去**，建得起来才答 true。
///
/// **仍然没做到的那一半**（如实记，别把这条读成「执行结果会逐次上报」）：
/// 每次执行到底有没有进作业，`run_bounded` 只在 stderr 上喊一句，
/// **没有给宿主侧的结构化出口**；`bounded` / `execTool` 的 `sandboxed` 仍是平台级说法。
/// 那一半要改的是 `engine/**`，不在本文件的范围里。
fn bounded_available() -> bool {
    #[cfg(target_os = "windows")]
    {
        win::probe_bounded(DEFAULT_MEMORY_MB, DEFAULT_PROCESSES)
    }
    #[cfg(not(target_os = "windows"))]
    {
        false
    }
}

fn main() -> ExitCode {
    let argv: Vec<String> = std::env::args().collect();

    // `--probe`：只报能力，不跑命令（doctor 用它，不需要真的执行一条命令）
    if wants_probe(&argv) {
        println!(
            "{{\"bounded\":{},\"platform\":\"{}\",\"defaultMemoryMb\":{},\"defaultProcesses\":{}}}",
            bounded_available(),
            std::env::consts::OS,
            DEFAULT_MEMORY_MB,
            DEFAULT_PROCESSES
        );
        return ExitCode::SUCCESS;
    }

    let args = match parse_args(argv) {
        Ok(a) => a,
        Err(msg) => {
            eprintln!("ding-sandbox：{msg}");
            return ExitCode::from(2);
        }
    };

    /* `--from-env`：命令行换成环境变量里的那一条（shell 与固定旗标仍来自 argv） */
    let command = if args.from_env {
        match std::env::var("DING_SANDBOX_COMMAND") {
            Ok(v) => v,
            Err(_) => {
                eprintln!("ding-sandbox：--from-env 但环境里没有 DING_SANDBOX_COMMAND");
                return ExitCode::from(2);
            }
        }
    } else {
        String::new()
    };

    #[cfg(target_os = "windows")]
    let status = if bounded_available() {
        win::run_bounded(&args.command, args.memory_mb, args.processes, if args.from_env { Some(&command) } else { None })
    } else {
        /*
         * 走到这里 = 连作业对象都建不起来（`--probe` 对同一件事答 false）。
         * 直通，但**命令载体仍走 `raw_arg`**（`win::plain` 就是干这个的）：
         * Windows 上只有它能让含引号的命令原样到 `cmd.exe` 手里（见 `--from-env` 的说明）。
         */
        eprintln!("ding-sandbox：这台机器上作业对象建不起来（`--probe` 也这么答）—— 这一条命令将**不受限**地跑");
        win::plain(&args.command, if args.from_env { Some(&command) } else { None })
    };
    #[cfg(not(target_os = "windows"))]
    let status = plain_passthrough(&args.command, if args.from_env { Some(&command) } else { None });

    match status {
        /*
         * 退出码**原样**透出去（上层按它判成败）。
         *
         * ⚠️ 不能拿 `ExitCode::from(u8)` 装（2026-10-16，审计 P113）：Windows 上
         * `ExitStatus::code()` 是 `Option<i32>`，而 0x80000000 以上的终止状态在这条
         * 通道里是**负数**（0xC0000005 访问违例 → -1073741819、0xC0000409 fastfail → -1073740791）。
         * 原来的 `.clamp(0, 255)` 把负数取成 0 —— 本机实测：让子进程以 0xFFFFFFFF / 0xC0000005
         * 退出，旧二进制对上报告的就是「退出码 0」，新二进制报 4294967295 / 3221225477。
         * 于是「原生子进程崩了 / 被上限杀掉」会被报成「退出码 0 = 成功」，
         * 这一层最核心的卖点在退出码这一维上反而撒了谎（与下行「不编一个 0」的注释自相矛盾）。
         * （⚠️ 强度：Node 子进程那两条路**看不出**这条差别 —— 实测 JS 分配失败退 1、
         * `process.abort()` 退 134，都是正常码；所以这条只在原生子进程/NTSTATUS 终止时咬人。）
         * 所以改走 `std::process::exit(i32)`：整个 i32 都是它（Windows 上就是这个进程的
         * 退出码位形），256 以上与负数都不再被夹掉。
         *
         * 拿不到退出码（被信号杀掉那种）给 1 —— **不编一个 0**（0 会被当成"成功了"）。
         */
        Ok(st) => std::process::exit(exit_code_of(st.code())),
        Err(e) => {
            eprintln!("ding-sandbox：命令没跑起来：{e}");
            ExitCode::from(3)
        }
    }
}

/// 子进程的退出码怎么变成**我们这个进程的**退出码（纯函数，判据在文件末尾的测试里）。
///
/// ⚠️ 这里是审计 P113 的那条不变量，别顺手"规整"它：
///   · 拿得到就**原样**给（Windows 上 0x80000000 以上的终止状态是负数，
///     256 以上的也原样留着 —— 夹成 `u8` 会把它们变成 255 或 **0**）；
///   · 拿不到（被信号杀掉那种）给 1 —— **不编一个 0**（0 会被当成"成功了"）。
fn exit_code_of(raw: Option<i32>) -> i32 {
    raw.unwrap_or(1)
}

/// 没有上限地直接跑（非 Windows 的兜底路径与「约束设不上」的退路；调用方负责说清"这条没受限"）。
///
/// ⚠️ `--from-env` 的命令载体与 Windows 那条路**必须同源**（2026-10-16，审计 P112）：
/// 走 `--from-env` 时命令在环境变量里、argv 里**只有 shell 与固定旗标**（宿主侧
/// `planFor` 拼的就是 `/bin/sh -c`），而原先非 Windows 那一支只跑 argv —— 于是
/// `sh -c` 不带操作数，任何命令都失败（不是「直通执行」而是坏掉），
/// 而头注与 SAFETY.md 都写着那两个平台「只是直通执行」。
/// 现在把那条命令**当成 shell 的一个操作数**接在固定旗标后面，就是 `sh -c <整条命令>`。
///
/// ⚠️ 这一步假定 `command[0]` 是 shell（宿主侧拼的就是它）。换成别的程序时，
/// `--from-env` 那条字符串只会变成它的一个参数 —— 这条边界如实记在这里，没假装通用。
#[cfg_attr(target_os = "windows", allow(dead_code))] // Windows 上走 win::plain（那边要 raw_arg），这一支只给非 Windows 用
fn plain_passthrough(command: &[String], raw_command: Option<&str>) -> std::io::Result<std::process::ExitStatus> {
    let mut cmd = std::process::Command::new(&command[0]);
    cmd.args(&command[1..]);
    if let Some(raw) = raw_command {
        cmd.arg(raw);
    }
    cmd.status()
}

/*
 * 单元测试（`cargo test` 跑；纯逻辑那一半的判据）。
 *
 * ⚠️ 强度说清：这几条钉的是**纯函数**（退出码映射、上限校验、`--probe` 的识别位置）。
 * 「子进程真的被作业对象限住」「退出码真的原样透到宿主」这两条要看整个进程的行为，
 * 只能在真机上冒烟（本机实测记录见本轮汇报），单测覆盖不到。
 */
#[cfg(test)]
mod tests {
    use super::*;

    fn argv(xs: &[&str]) -> Vec<String> {
        xs.iter().map(|s| s.to_string()).collect()
    }

    /// P113：退出码**不许**被夹进 `u8`（0..=255）。
    ///
    /// 这两个负数就是这条缺陷的形状：Windows 上 0xC0000005（访问违例）作为 i32 是
    /// -1073741819，被 `clamp(0, 255)` 夹成 **0** —— 被作业上限杀掉或自己崩了，
    /// 对上报告的是「退出码 0 = 成功」。谁要把映射改回 `u8`，这条会红。
    #[test]
    fn exit_code_is_not_clamped_to_u8() {
        assert_eq!(exit_code_of(Some(0)), 0);
        assert_eq!(exit_code_of(Some(7)), 7);
        assert_eq!(exit_code_of(Some(300)), 300); // 原来的 clamp 会给 255
        assert_eq!(exit_code_of(Some(-1)), -1); // 原来的 clamp 会给 0
        assert_eq!(exit_code_of(Some(-1073741819)), -1073741819); // 0xC0000005，原来会给 0
        assert_eq!(exit_code_of(Some(-1073740791)), -1073740791); // 0xC0000409（fastfail）
        assert_eq!(exit_code_of(None), 1); // 拿不到时也不许编 0
    }

    /// P122：上限 0 按用法错误拒掉（本机实测 0 会让整条约束失效，见 `check_limit` 的说明）。
    #[test]
    fn zero_limit_is_usage_error() {
        assert!(check_limit("--memory-mb", 0).is_err());
        assert!(check_limit("--processes", 0).is_err());
        assert!(check_limit("--memory-mb", 1).is_ok());
        assert!(parse_args(argv(&["ding-sandbox", "--memory-mb", "0", "--", "echo"])).is_err());
        assert!(parse_args(argv(&["ding-sandbox", "--processes", "0", "--", "echo"])).is_err());
    }

    /// P121：`--probe` 只在第一个 `--` **之前**算数（`--` 之后是命令自己的参数）。
    ///
    /// 判据形状必须是「带 `--` 的那些」：退回原来那种「整个 argv 里 any()」时，
    /// 后四条会红（把命令的那次执行当成问能力，只打 JSON 就退 0）。
    #[test]
    fn probe_only_before_separator() {
        assert!(wants_probe(&argv(&["ding-sandbox", "--probe"])));
        assert!(wants_probe(&argv(&["ding-sandbox", "--memory-mb", "512", "--probe"])));
        assert!(!wants_probe(&argv(&["ding-sandbox", "--", "mytool", "--probe"])));
        assert!(!wants_probe(&argv(&["ding-sandbox", "--from-env", "--", "cmd.exe", "--probe"])));
        assert!(!wants_probe(&argv(&["ding-sandbox", "--", "--probe"])));
        assert!(!wants_probe(&argv(&["ding-sandbox", "--", "echo"])));
    }

    /// 默认上限与「`--` 之后一个字符都不再当选项」（命令自己可能带 `--memory-mb` 这种参数）。
    #[test]
    fn separator_stops_option_parsing() {
        let plain = parse_args(argv(&["ding-sandbox", "--", "echo"])).expect("最小用法应当解析成功");
        assert_eq!(plain.memory_mb, DEFAULT_MEMORY_MB);
        assert_eq!(plain.processes, DEFAULT_PROCESSES);
        assert!(!plain.from_env);

        let full = parse_args(argv(&["ding-sandbox", "--memory-mb", "512", "--", "echo", "--memory-mb", "9"]))
            .expect("应当解析成功");
        assert_eq!(full.memory_mb, 512);
        assert_eq!(full.command, argv(&["echo", "--memory-mb", "9"]));
    }
}
