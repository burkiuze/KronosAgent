//! kronos-sandbox — run one command with the file system made read-only except for the given
//! directories, and optionally without network access.
//!
//! Linux only. File system rules use Landlock (kernel 5.13+); network isolation uses Landlock's
//! TCP rules (6.7+) or, on older kernels, an unprivileged user + network namespace. Nothing
//! needs root and nothing is left behind: the restrictions apply to this process and everything
//! it starts, and end with it.
//!
//! Usage:
//!   kronos-sandbox [--write DIR]... [--no-network | --allow-connect-port PORT] [--best-effort] -- COMMAND [ARGS]...
//!   kronos-sandbox --probe          print what this kernel supports, as JSON
//!
//! Exit codes: the command's own, or 125 when the sandbox could not be set up (unless
//! --best-effort, which runs the command with whatever could be applied and says so on stderr).

#[cfg(target_os = "linux")]
mod linux {
    use std::ffi::{c_int, c_long, c_void};
    use std::fs::OpenOptions;
    use std::io;
    use std::os::unix::fs::OpenOptionsExt;
    use std::os::unix::io::AsRawFd;

    extern "C" {
        fn syscall(num: c_long, ...) -> c_long;
        fn prctl(option: c_int, ...) -> c_int;
        fn unshare(flags: c_int) -> c_int;
        fn getuid() -> u32;
        fn getgid() -> u32;
    }

    // same numbers on every architecture (unified syscall table)
    const SYS_LANDLOCK_CREATE_RULESET: c_long = 444;
    const SYS_LANDLOCK_ADD_RULE: c_long = 445;
    const SYS_LANDLOCK_RESTRICT_SELF: c_long = 446;
    const LANDLOCK_CREATE_RULESET_VERSION: u32 = 1;
    const LANDLOCK_RULE_PATH_BENEATH: c_int = 1;
    const LANDLOCK_RULE_NET_PORT: c_int = 2;
    const PR_SET_NO_NEW_PRIVS: c_int = 38;
    const CLONE_NEWUSER: c_int = 0x1000_0000;
    const CLONE_NEWNET: c_int = 0x4000_0000;
    const O_PATH: c_int = 0o10_000_000;
    const O_CLOEXEC: c_int = 0o2_000_000;

    const EXECUTE: u64 = 1 << 0;
    const WRITE_FILE: u64 = 1 << 1;
    const READ_FILE: u64 = 1 << 2;
    const READ_DIR: u64 = 1 << 3;
    const REFER: u64 = 1 << 13; // ABI 2
    const TRUNCATE: u64 = 1 << 14; // ABI 3
    const IOCTL_DEV: u64 = 1 << 15; // ABI 5
    const NET_BIND_TCP: u64 = 1 << 0;
    const NET_CONNECT_TCP: u64 = 1 << 1;

    #[repr(C)]
    struct RulesetAttr {
        handled_access_fs: u64,
        handled_access_net: u64,
    }

    #[repr(C)]
    struct NetPortAttr {
        allowed_access: u64,
        port: u64,
    }

    #[repr(C, packed)]
    struct PathBeneathAttr {
        allowed_access: u64,
        parent_fd: i32,
    }

    pub fn abi() -> i64 {
        unsafe { syscall(SYS_LANDLOCK_CREATE_RULESET, std::ptr::null::<c_void>(), 0usize, LANDLOCK_CREATE_RULESET_VERSION) as i64 }
    }

    /// Every file-system right this ABI knows about.
    fn fs_rights(abi: i64) -> u64 {
        let mut all = (1u64 << 13) - 1; // ABI 1: bits 0..=12
        if abi >= 2 {
            all |= REFER;
        }
        if abi >= 3 {
            all |= TRUNCATE;
        }
        if abi >= 5 {
            all |= IOCTL_DEV;
        }
        all
    }

    fn add_path(ruleset: c_int, path: &str, access: u64) -> io::Result<()> {
        let f = OpenOptions::new().read(true).custom_flags(O_PATH | O_CLOEXEC).open(path)?;
        let is_dir = f.metadata().map(|m| m.is_dir()).unwrap_or(false);
        // rights that only make sense on directories cannot be granted on a single file
        let file_only = WRITE_FILE | READ_FILE | EXECUTE | TRUNCATE | IOCTL_DEV;
        let attr = PathBeneathAttr { allowed_access: if is_dir { access } else { access & file_only }, parent_fd: f.as_raw_fd() };
        let r = unsafe { syscall(SYS_LANDLOCK_ADD_RULE, ruleset, LANDLOCK_RULE_PATH_BENEATH, &attr as *const PathBeneathAttr, 0u32) };
        if r < 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(())
    }

    /// Map our own uid/gid into a fresh user namespace with its own (empty) network namespace.
    fn isolate_network() -> io::Result<()> {
        let (uid, gid) = unsafe { (getuid(), getgid()) };
        if unsafe { unshare(CLONE_NEWUSER | CLONE_NEWNET) } != 0 {
            return Err(io::Error::last_os_error());
        }
        let _ = std::fs::write("/proc/self/setgroups", "deny");
        std::fs::write("/proc/self/uid_map", format!("{uid} {uid} 1"))?;
        std::fs::write("/proc/self/gid_map", format!("{gid} {gid} 1"))?;
        Ok(())
    }

    pub struct Applied {
        pub fs: bool,
        pub network: Option<&'static str>,
        pub notes: Vec<String>,
    }

    pub fn apply(writable: &[String], no_network: bool, allow_port: Option<u16>) -> Applied {
        let abi = abi();
        let mut out = Applied { fs: false, network: None, notes: Vec::new() };
        // network first: a new user namespace must be created before Landlock restricts us
        let net_by_landlock = no_network && abi >= 4;
        if allow_port.is_some() && !net_by_landlock {
            // an empty network namespace cannot reach the proxy on the host's loopback
            out.notes.push("network through the proxy needs Landlock network rules (kernel 6.7+)".to_string());
            return out;
        }
        if no_network && !net_by_landlock {
            match isolate_network() {
                Ok(()) => out.network = Some("namespace"),
                Err(e) => out.notes.push(format!("network not restricted: {e}")),
            }
        }
        if abi < 1 {
            out.notes.push(format!("Landlock is not available on this kernel ({})", io::Error::last_os_error()));
            return out;
        }
        let all = fs_rights(abi);
        let attr = RulesetAttr { handled_access_fs: all, handled_access_net: if net_by_landlock { NET_BIND_TCP | NET_CONNECT_TCP } else { 0 } };
        let size = if abi >= 4 { std::mem::size_of::<RulesetAttr>() } else { 8 };
        let ruleset = unsafe { syscall(SYS_LANDLOCK_CREATE_RULESET, &attr as *const RulesetAttr, size, 0u32) } as c_int;
        if ruleset < 0 {
            out.notes.push(format!("could not create the Landlock ruleset: {}", io::Error::last_os_error()));
            return out;
        }
        // everything readable and executable; ioctl on devices so terminals keep working
        let read = EXECUTE | READ_FILE | READ_DIR | if abi >= 5 { IOCTL_DEV } else { 0 };
        if let Err(e) = add_path(ruleset, "/", read) {
            out.notes.push(format!("could not allow reading /: {e}"));
            return out;
        }
        for dev in ["/dev/null", "/dev/zero", "/dev/full", "/dev/random", "/dev/urandom", "/dev/tty", "/dev/ptmx", "/dev/pts", "/dev/shm", "/proc/self/fd"] {
            let _ = add_path(ruleset, dev, all);
        }
        for dir in writable {
            if let Err(e) = add_path(ruleset, dir, all) {
                out.notes.push(format!("{dir}: {e}"));
            }
        }
        if let (true, Some(port)) = (net_by_landlock, allow_port) {
            let attr = NetPortAttr { allowed_access: NET_CONNECT_TCP, port: port as u64 };
            if unsafe { syscall(SYS_LANDLOCK_ADD_RULE, ruleset, LANDLOCK_RULE_NET_PORT, &attr as *const NetPortAttr, 0u32) } < 0 {
                out.notes.push(format!("could not allow the proxy port: {}", io::Error::last_os_error()));
                return out;
            }
        }
        if unsafe { prctl(PR_SET_NO_NEW_PRIVS, 1 as c_long, 0 as c_long, 0 as c_long, 0 as c_long) } != 0 {
            out.notes.push(format!("no_new_privs: {}", io::Error::last_os_error()));
            return out;
        }
        if unsafe { syscall(SYS_LANDLOCK_RESTRICT_SELF, ruleset, 0u32) } != 0 {
            out.notes.push(format!("could not enforce the Landlock ruleset: {}", io::Error::last_os_error()));
            return out;
        }
        out.fs = true;
        if net_by_landlock {
            out.network = Some("landlock");
        }
        out
    }

    pub fn userns_available() -> bool {
        // try in a throwaway child so this process is not changed
        match unsafe { libc_fork() } {
            0 => {
                let ok = unsafe { unshare(CLONE_NEWUSER | CLONE_NEWNET) } == 0;
                unsafe { libc_exit(if ok { 0 } else { 1 }) }
            }
            pid if pid > 0 => {
                let mut status: c_int = 0;
                unsafe { libc_waitpid(pid, &mut status, 0) };
                status == 0
            }
            _ => false,
        }
    }

    extern "C" {
        #[link_name = "fork"]
        fn libc_fork() -> c_int;
        #[link_name = "_exit"]
        fn libc_exit(code: c_int) -> !;
        #[link_name = "waitpid"]
        fn libc_waitpid(pid: c_int, status: *mut c_int, options: c_int) -> c_int;
    }
}

use std::process::{exit, Command};

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.first().map(String::as_str) == Some("--probe") {
        #[cfg(target_os = "linux")]
        {
            let abi = linux::abi();
            println!("{{\"os\":\"linux\",\"landlock\":{},\"userns\":{}}}", abi.max(0), linux::userns_available());
        }
        #[cfg(not(target_os = "linux"))]
        println!("{{\"os\":\"{}\",\"landlock\":0,\"userns\":false}}", std::env::consts::OS);
        return;
    }
    let mut writable: Vec<String> = Vec::new();
    let mut no_network = false;
    let mut best_effort = false;
    let mut allow_port: Option<u16> = None;
    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "--write" => {
                i += 1;
                if let Some(d) = args.get(i) {
                    writable.push(d.clone());
                }
            }
            "--no-network" => no_network = true,
            "--allow-connect-port" => {
                i += 1;
                allow_port = args.get(i).and_then(|p| p.parse().ok());
                no_network = true;
            }
            "--best-effort" => best_effort = true,
            "--" => {
                i += 1;
                break;
            }
            other => {
                eprintln!("kronos-sandbox: unknown option {other}");
                exit(125);
            }
        }
        i += 1;
    }
    let command = &args[i.min(args.len())..];
    if command.is_empty() {
        eprintln!("usage: kronos-sandbox [--write DIR]... [--no-network] [--best-effort] -- COMMAND [ARGS]...");
        exit(125);
    }

    #[cfg(target_os = "linux")]
    {
        let applied = linux::apply(&writable, no_network, allow_port);
        let complete = applied.fs && (!no_network || applied.network.is_some());
        if !complete {
            for n in &applied.notes {
                eprintln!("kronos-sandbox: {n}");
            }
            if !best_effort {
                exit(125);
            }
        }
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = (&writable, no_network, allow_port);
        if !best_effort {
            eprintln!("kronos-sandbox: only Linux is supported (macOS uses sandbox-exec)");
            exit(125);
        }
    }

    use std::os::unix::process::CommandExt;
    let err = Command::new(&command[0]).args(&command[1..]).exec();
    eprintln!("kronos-sandbox: {}: {err}", command[0]);
    exit(127);
}
