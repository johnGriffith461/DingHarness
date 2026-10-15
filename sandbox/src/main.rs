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
//! · **Linux 的 seccomp / macOS 的 seatbelt 还没有**：那两个平台目前只是直通执行
//!   （见 `unbounded`），差别会由 `ding doctor` 与 SAFETY.md 如实报出来。
//! · 命令本身仍然看得见 `$PATH` 与当前环境（脱敏环境变量是另一件事）。

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
    /// 命令来自环境变量 `DING_SANDBOX_COMMAND`（见文件末尾"为什么要走环境变量"）。
    from_env: bool,
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
                memory_mb = v.parse().map_err(|_| format!("--memory-mb 不是数字：{v}"))?;
            }
            "--processes" => {
                let v = it.next().ok_or("--processes 后面要给一个数")?;
                processes = v.parse().map_err(|_| format!("--processes 不是数字：{v}"))?;
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

/// 本平台有没有真的"有界"实现（命令行上的 `--probe` 用它，doctor 也问它）。
fn bounded_available() -> bool {
    cfg!(target_os = "windows")
}

fn main() -> ExitCode {
    let argv: Vec<String> = std::env::args().collect();

    // `--probe`：只报能力，不跑命令（doctor 用它，不需要真的执行一条命令）
    if argv.iter().any(|a| a == "--probe") {
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

    let status = if bounded_available() {
        win::run_bounded(&args.command, args.memory_mb, args.processes, if args.from_env { Some(&command) } else { None })
    } else {
        // 没有隔离实现的平台：直通执行。
        // ⚠️ **不假装**：这里没有任何限制，SAFETY.md 与 doctor 都会这么说。
        std::process::Command::new(&args.command[0])
            .args(&args.command[1..])
            .status()
    };

    match status {
        /*
         * 退出码原样透出去（上层按它判成败）。`ExitStatus.code()` 在 Windows 上就是子进程的退出码；
         * 拿不到（被信号杀掉那种）时给 1 —— **不编一个 0**（0 会被当成"成功了"）。
         */
        Ok(st) => ExitCode::from(st.code().unwrap_or(1).clamp(0, 255) as u8),
        Err(e) => {
            eprintln!("ding-sandbox：命令没跑起来：{e}");
            ExitCode::from(3)
        }
    }
}
