//! In-process fallback: run the installed `axiom gate` with the bytes already read from stdin.
//! Discovery never goes through a shell (cmd.exe / sh): PATH is searched by hand.

use std::ffi::OsString;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

pub const ENV_OVERRIDE: &str = "AXIOM_HOOK_FALLBACK";
/// Deadline for the fallback `axiom gate` (ms, 100..=600000); default 10 s.
pub const ENV_TIMEOUT: &str = "AXIOM_HOOK_FALLBACK_TIMEOUT_MS";
pub const DEFAULT_TIMEOUT: Duration = Duration::from_secs(10);

pub fn timeout() -> Duration {
    std::env::var(ENV_TIMEOUT)
        .ok()
        .and_then(|v| v.trim().parse::<u64>().ok())
        .filter(|ms| (100..=600_000).contains(ms))
        .map_or(DEFAULT_TIMEOUT, Duration::from_millis)
}
const CLI_REL: [&str; 5] = ["node_modules", "@codai", "axiom-mcp", "dist", "cli.js"];

/// How to start the full gate: `program` + leading args, then `gate <args…>`.
#[derive(Debug, Clone, PartialEq)]
pub struct Launcher {
    pub program: PathBuf,
    pub lead: Vec<OsString>,
}

fn is_script(p: &Path) -> bool {
    matches!(
        p.extension()
            .and_then(|e| e.to_str())
            .map(str::to_ascii_lowercase)
            .as_deref(),
        Some("js" | "mjs" | "cjs")
    )
}

#[cfg(unix)]
fn is_executable(p: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    std::fs::metadata(p)
        .map(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
        .unwrap_or(false)
}

#[cfg(not(unix))]
fn is_executable(p: &Path) -> bool {
    p.is_file()
}

fn search_path(path_var: Option<&OsString>, name: &str) -> Option<PathBuf> {
    std::env::split_paths(path_var?)
        .filter(|d| !d.as_os_str().is_empty())
        .map(|d| d.join(name))
        .find(|p| is_executable(p))
}

fn node_name() -> &'static str {
    if cfg!(windows) { "node.exe" } else { "node" }
}

fn node_launcher(
    path_var: Option<&OsString>,
    near: Option<&Path>,
    script: PathBuf,
) -> Option<Launcher> {
    let node = near
        .map(|d| d.join(node_name()))
        .filter(|p| is_executable(p))
        .or_else(|| search_path(path_var, node_name()))?;
    Some(Launcher {
        program: node,
        lead: vec![script.into_os_string()],
    })
}

/// Pure discovery over an explicit environment (testable).
pub fn discover(override_path: Option<OsString>, path_var: Option<OsString>) -> Option<Launcher> {
    if let Some(o) = override_path.filter(|o| !o.is_empty()) {
        let p = PathBuf::from(o);
        if !p.is_file() {
            return None; // an explicit override that does not exist must not silently widen
        }
        return if is_script(&p) {
            let dir = p.parent().map(Path::to_path_buf);
            node_launcher(path_var.as_ref(), dir.as_deref(), p)
        } else {
            Some(Launcher {
                program: p,
                lead: vec![],
            })
        };
    }
    let exe = if cfg!(windows) { "axiom.exe" } else { "axiom" };
    if let Some(p) = search_path(path_var.as_ref(), exe) {
        return Some(Launcher {
            program: p,
            lead: vec![],
        });
    }
    if cfg!(windows) {
        // npm/pnpm global install: `<dir>\axiom.cmd` shim. Run its cli.js with node directly.
        let shim_dir =
            std::env::split_paths(path_var.as_ref()?).find(|d| d.join("axiom.cmd").is_file())?;
        let rel: PathBuf = CLI_REL.iter().collect();
        let script = [
            shim_dir.join(&rel),
            shim_dir.join("global").join("5").join(&rel),
        ]
        .into_iter()
        .find(|p| p.is_file())?;
        return node_launcher(path_var.as_ref(), Some(&shim_dir), script);
    }
    None
}

/// Run the fallback; `None` when it could not be started, died without an exit code, or did not
/// finish within `deadline` (then it is killed — the caller fails closed).
pub fn run(
    launcher: &Launcher,
    args: &[String],
    stdin_bytes: Vec<u8>,
    deadline: Duration,
) -> Option<i32> {
    let mut child = Command::new(&launcher.program)
        .args(&launcher.lead)
        .arg("gate")
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit())
        .spawn()
        .ok()?;
    let mut stdin = child.stdin.take()?;
    // Write on a thread: a child that exits without draining stdin must not wedge us.
    let writer = std::thread::spawn(move || {
        let _ = stdin.write_all(&stdin_bytes);
    });
    let until = Instant::now() + deadline;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                let _ = writer.join();
                return status.code();
            }
            Ok(None) if Instant::now() < until => std::thread::sleep(Duration::from_millis(10)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return None; // the writer thread may still be blocked on a full pipe: detach it
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("axiom-hook-fb-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn touch(p: &Path) {
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, b"").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(p, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
    }

    #[test]
    fn missing_override_disables_discovery() {
        let d = tmp("ov");
        touch(&d.join(if cfg!(windows) { "axiom.exe" } else { "axiom" }));
        let path = std::env::join_paths([&d]).unwrap();
        assert_eq!(
            discover(Some(d.join("nope.js").into()), Some(path.clone())),
            None
        );
        assert!(discover(None, Some(path)).is_some());
    }

    #[test]
    fn override_exe_runs_directly_and_js_runs_with_node() {
        let d = tmp("ovjs");
        let exe = d.join("custom-axiom");
        touch(&exe);
        let l = discover(Some(exe.clone().into()), None).expect("launcher");
        assert_eq!((l.program, l.lead.len()), (exe, 0));

        let js = d.join("cli.js");
        touch(&js);
        let node = d.join(node_name());
        touch(&node);
        let l = discover(Some(js.clone().into()), None).expect("node next to cli.js");
        assert_eq!(l.program, node);
        assert_eq!(l.lead, vec![js.into_os_string()]);
    }

    #[test]
    fn finds_axiom_on_path() {
        let a = tmp("pa");
        let b = tmp("pb");
        let exe = b.join(if cfg!(windows) { "axiom.exe" } else { "axiom" });
        touch(&exe);
        let path = std::env::join_paths([&a, &b]).unwrap();
        assert_eq!(discover(None, Some(path)).map(|l| l.program), Some(exe));
        assert_eq!(
            discover(None, Some(std::env::join_paths([&a]).unwrap())),
            None
        );
        assert_eq!(discover(None, None), None);
    }

    #[cfg(windows)]
    #[test]
    fn npm_and_pnpm_shims_resolve_to_cli_js() {
        let npm = tmp("npm");
        touch(&npm.join("axiom.cmd"));
        touch(&npm.join("node.exe"));
        let cli: PathBuf = CLI_REL.iter().collect();
        touch(&npm.join(&cli));
        let l = discover(None, Some(std::env::join_paths([&npm]).unwrap())).expect("npm shim");
        assert_eq!(l.program, npm.join("node.exe"));
        assert_eq!(l.lead, vec![npm.join(&cli).into_os_string()]);

        let pnpm = tmp("pnpm");
        touch(&pnpm.join("axiom.cmd"));
        touch(&pnpm.join("global").join("5").join(&cli));
        // no node.exe beside the shim → node from PATH (the npm dir above)
        let l =
            discover(None, Some(std::env::join_paths([&pnpm, &npm]).unwrap())).expect("pnpm shim");
        assert_eq!(l.program, npm.join("node.exe"));
        assert_eq!(
            l.lead,
            vec![pnpm.join("global").join("5").join(&cli).into_os_string()]
        );
    }
}
