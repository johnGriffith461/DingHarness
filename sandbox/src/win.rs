//! Windows 的**有界执行**：Job Object（Phase 14.1）。
//!
//! ## 为什么用 Job Object
//!
//! 它是 Windows 上唯一"内建、无需额外运行时"的进程组约束：
//! 内存上限、子进程数上限、以及**关掉句柄就杀掉整组**（KILL_ON_JOB_CLOSE）。
//! 后一条特别重要 —— 命令跑完（或被中止）之后，它起的那一堆子进程不会留下来变成孤儿。
//!
//! ## 已知的一处**竞态**（如实写，不藏着）
//!
//! 理想做法是"以挂起状态创建 → 放进作业 → 恢复执行"。Rust 标准库的
//! `Command::spawn` 不暴露线程句柄，所以这里只能"先启动、再放进作业"——
//! 中间那一瞬（通常几毫秒）进程还没受限。
//!
//! 这条竞态**不影响主要目的**（挡住失控的内存与 fork 炸弹：那两者都在进程活了一段之后才发生），
//! 但它意味着**不该把这一层当安全边界**（SAFETY.md 里就是这么写的）。
//! 要消掉它得改用 `CreateProcessW` + `CREATE_SUSPENDED` 自己建进程 ——
//! 那是"更彻底"与"这一层本来就不是安全边界"之间的取舍，现在选后者并写明。

use std::os::windows::process::CommandExt;
use std::process::{Command, ExitStatus};

/// 关掉命令自己的窗口（GUI 子进程不弹黑框；服务/无头场景也适用）。
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

// ── FFI 声明（零依赖：手写 extern）─────────────────────────────

type Handle = *mut core::ffi::c_void;

#[repr(C)]
#[derive(Default)]
struct IoCounters {
    read_operation_count: u64,
    write_operation_count: u64,
    other_operation_count: u64,
    read_transfer_count: u64,
    write_transfer_count: u64,
    other_transfer_count: u64,
}

#[repr(C)]
#[derive(Default)]
struct BasicLimitInformation {
    per_process_user_time_limit: i64,
    per_job_user_time_limit: i64,
    limit_flags: u32,
    minimum_working_set_size: usize,
    maximum_working_set_size: usize,
    active_process_limit: u32,
    affinity: usize,
    priority_class: u32,
    scheduling_class: u32,
}

#[repr(C)]
#[derive(Default)]
struct ExtendedLimitInformation {
    basic_limit_information: BasicLimitInformation,
    io_info: IoCounters,
    process_memory_limit: usize,
    job_memory_limit: usize,
    peak_process_memory_used: usize,
    peak_job_memory_used: usize,
}

#[link(name = "kernel32")]
extern "system" {
    fn CreateJobObjectW(attrs: *mut core::ffi::c_void, name: *const u16) -> Handle;
    fn SetInformationJobObject(job: Handle, class: i32, info: *mut core::ffi::c_void, len: u32) -> i32;
    fn AssignProcessToJobObject(job: Handle, process: Handle) -> i32;
    fn CloseHandle(h: Handle) -> i32;
    fn GetLastError() -> u32;
}

/// `JOBOBJECTINFOCLASS`：`JobObjectExtendedLimitInformation`
const JOB_OBJECT_EXTENDED_LIMIT_INFORMATION: i32 = 9;

/// 上限标志位
const JOB_OBJECT_LIMIT_PROCESS_MEMORY: u32 = 0x0000_0100;
const JOB_OBJECT_LIMIT_JOB_MEMORY: u32 = 0x0000_0200;
const JOB_OBJECT_LIMIT_ACTIVE_PROCESS: u32 = 0x0000_0008;
const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE: u32 = 0x0000_2000;

/// 把一个作业对象设上限。成功返回作业句柄；失败返回 Err（**调用方必须如实回报，不能静默放行**）。
unsafe fn make_job(memory_mb: u64, processes: u32) -> Result<Handle, String> {
    let job = CreateJobObjectW(core::ptr::null_mut(), core::ptr::null());
    if job.is_null() {
        return Err(format!("CreateJobObject 失败（错误码 {}）", GetLastError()));
    }
    let mut info = ExtendedLimitInformation::default();
    info.basic_limit_information.limit_flags = JOB_OBJECT_LIMIT_PROCESS_MEMORY
        | JOB_OBJECT_LIMIT_JOB_MEMORY
        | JOB_OBJECT_LIMIT_ACTIVE_PROCESS
        // ⭐ 这一条最关键：沙箱退出（句柄关闭）时，作业里**所有**进程一起被终止 ——
        // 命令起的那堆子进程不会变成孤儿。
        | JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    info.basic_limit_information.active_process_limit = processes;
    let bytes = (memory_mb as usize).saturating_mul(1024 * 1024);
    info.process_memory_limit = bytes;
    info.job_memory_limit = bytes;

    let ok = SetInformationJobObject(
        job,
        JOB_OBJECT_EXTENDED_LIMIT_INFORMATION,
        &mut info as *mut _ as *mut core::ffi::c_void,
        core::mem::size_of::<ExtendedLimitInformation>() as u32,
    );
    if ok == 0 {
        let code = GetLastError();
        CloseHandle(job);
        return Err(format!("SetInformationJobObject 失败（错误码 {code}）"));
    }
    Ok(job)
}

/// 有界执行。返回子进程的退出状态。
///
/// `raw_command` 给了就**原样**拼到命令行末尾（`raw_arg`，见 `--from-env` 的说明）；
/// 没给就按 argv 逐个传（命令本身就是程序 + 参数那种情形）。
pub fn run_bounded(
    command: &[String],
    memory_mb: u64,
    processes: u32,
    raw_command: Option<&str>,
) -> std::io::Result<ExitStatus> {
    unsafe {
        let job = match make_job(memory_mb, processes) {
            Ok(h) => h,
            Err(msg) => {
                /*
                 * ⚠️ 设不了上限就**直通执行但明说**（打到 stderr）：
                 * 悄悄退化成"没有沙箱"比报错更坏 —— 用户以为有隔离，实际没有。
                 */
                eprintln!("ding-sandbox：{msg} —— 这一条命令将**不受限**地跑");
                return plain(command, raw_command);
            }
        };

        let mut cmd = Command::new(&command[0]);
        cmd.args(&command[1..]);
        if let Some(raw) = raw_command {
            /*
             * ⚠️ `raw_arg` 是这一整条链的关键：它把字符串**按原样**接进命令行，
             * 不再走一遍 CRT 的引号转义 —— 于是 `cmd.exe` 看到的就是用户敲的那一条。
             */
            cmd.raw_arg(raw);
        }
        let child = cmd.creation_flags(CREATE_NO_WINDOW).spawn()?;

        // 放进作业（见文件头那条竞态说明）
        let handle = child.as_raw_handle() as Handle;
        if AssignProcessToJobObject(job, handle) == 0 {
            eprintln!(
                "ding-sandbox：命令已启动，但放进作业失败（错误码 {}）—— 这一条命令**不受限**",
                GetLastError()
            );
        }

        // 等它退出，然后**关掉作业句柄**（KILL_ON_JOB_CLOSE 会把残留的子进程一起收掉）
        let mut child = child;
        let status = child.wait()?;
        CloseHandle(job);
        Ok(status)
    }
}

/// 试建一次作业对象并设上限，成功就答 true（`--probe` 用它，说明在 `main.rs` 的
/// `bounded_available`）。
///
/// ⚠️ 这是**能力探测**，不是「接下来每条命令都进了作业」：探测成功之后，
/// `run_bounded` 里那次 `AssignProcessToJobObject` 仍可能失败（实测：把活动进程数上限
/// 设成 0，作业建得起来而关联必然失败，错误码 1816）。探测能挡掉的是「这台机器根本建不出
/// 作业」那一档，剩下那一档今天只在 stderr 上喊一句。
pub fn probe_bounded(memory_mb: u64, processes: u32) -> bool {
    unsafe {
        match make_job(memory_mb, processes) {
            Ok(job) => {
                CloseHandle(job);
                true
            }
            Err(_) => false,
        }
    }
}

/// 没有上限地直接跑（兜底路径；调用方负责说清"这条没受限"）。
pub fn plain(command: &[String], raw_command: Option<&str>) -> std::io::Result<ExitStatus> {
    let mut cmd = Command::new(&command[0]);
    cmd.args(&command[1..]);
    if let Some(raw) = raw_command {
        cmd.raw_arg(raw);
    }
    cmd.creation_flags(CREATE_NO_WINDOW).status()
}

use std::os::windows::io::AsRawHandle;

/*
 * 单元测试（`cargo test` 跑）。
 *
 * ⚠️ 只钉**在本机与常见 Windows 上都成立**的那一条：上限值非法时 `SetInformationJobObject`
 * 必然失败。**不**在这里断言「默认上限一定建得起来」—— 那是环境相关的（受限容器里可能建不出），
 * 断它等于给守卫埋一条假红；那一半靠真机冒烟（`--probe` 应当答 `"bounded":true`）。
 */
#[cfg(test)]
mod tests {
    use super::*;

    /// P115：`--probe` 的答案必须是**真的建了一次作业对象**得来的，不是平台常量。
    ///
    /// 形状：内存上限给 0（本机实测 `SetInformationJobObject` 失败，错误码 87 = 参数无效）
    /// → `probe_bounded` 答 false。退回「回显 `cfg!(target_os = "windows")`」那种实现时，
    /// 它在这一档只会答 true —— 这台机器上连作业都建不出来时也不会说。
    #[test]
    fn probe_reflects_real_job_creation() {
        assert!(!probe_bounded(0, 32), "上限非法时建不出作业，probe 必须答 false");
    }
}
