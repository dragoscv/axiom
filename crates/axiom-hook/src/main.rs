//! `axiom-hook` — native thin client for the AXIOM resident gate daemon (`axiom serve --hook`).
//!
//!   axiom-hook --version
//!   axiom-hook gate <axiom gate flags…>     # e.g. gate --stdin --format claude
//!
//! Flow: read stdin (≤ 4 MiB, ≤ 2 s) → `~/.axiom/daemon.json` → `POST /v1/gate` on loopback →
//! verdict authenticated by `x-axiom-mac` (protocol 2). No verdict (daemon absent, refused, timed
//! out, non-200, unframed, bad MAC) → run the installed `axiom gate` with the same args and bytes
//! (deadline `AXIOM_HOOK_FALLBACK_TIMEOUT_MS`, default 10 s) → if that is impossible too, deny in
//! the harness format (fail-closed). A bad MAC under `AXIOM_GATE_DAEMON_STRICT=1` denies at once
//! with ERR_DAEMON_AUTH. Wire protocol: packages/mcp/src/daemon-proto.ts — change both together.

mod deny;
mod fallback;
mod http;
mod json;
mod pct;
mod sha;
mod state;

use std::io::{Read, Write};
use std::process::ExitCode;
use std::sync::mpsc;
use std::time::Duration;

/// GATE_STDIN_MAX_BYTES / GATE_STDIN_TIMEOUT_MS in packages/mcp/src/gate-fast.ts.
const STDIN_MAX_BYTES: usize = 4 * 1024 * 1024;
const STDIN_TIMEOUT: Duration = Duration::from_millis(2_000);

const USAGE: &str = "usage: axiom-hook --version\n       axiom-hook gate --stdin [--format auto|claude|copilot|vscode|codex|cursor|windsurf|gemini|junie|cline] [--deny-exit 0|2] [--root <dir>] [--profile <file>] [--fail-open] [...axiom gate flags]";

struct StdinRead {
    bytes: Vec<u8>,
    status: &'static str,
}

fn read_stdin() -> StdinRead {
    let (tx, rx) = mpsc::channel::<StdinRead>();
    std::thread::spawn(move || {
        let mut buf = Vec::new();
        let mut limited = std::io::stdin().lock().take(STDIN_MAX_BYTES as u64 + 1);
        let r = match limited.read_to_end(&mut buf) {
            Ok(_) if buf.len() > STDIN_MAX_BYTES => StdinRead {
                bytes: Vec::new(),
                status: "toolarge",
            },
            Ok(_) => StdinRead {
                bytes: buf,
                status: "ok",
            },
            // An unreadable stdin is reported like a timeout: the gate denies either way.
            Err(_) => StdinRead {
                bytes: Vec::new(),
                status: "timeout",
            },
        };
        let _ = tx.send(r);
    });
    rx.recv_timeout(STDIN_TIMEOUT).unwrap_or(StdinRead {
        bytes: Vec::new(),
        status: "timeout",
    })
}

fn exit_code(code: i32) -> ExitCode {
    ExitCode::from(u8::try_from(code).unwrap_or(1))
}

fn gate(args: Vec<String>) -> ExitCode {
    let flags = deny::parse_flags(&args);
    let input = if flags.stdin {
        read_stdin()
    } else {
        StdinRead {
            bytes: Vec::new(),
            status: "ok",
        }
    };

    if let Some(st) =
        state::read_state().filter(|s| s.protocol == f64::from(state::DAEMON_PROTOCOL))
    {
        let cwd = std::env::current_dir()
            .map(|p| p.to_string_lossy().into_owned())
            .unwrap_or_default();
        match http::round_trip(&st, &args, &cwd, input.status, &input.bytes) {
            http::Outcome::Verdict(v) => {
                let mut out = std::io::stdout().lock();
                let _ = out.write_all(&v.stdout);
                let _ = out.flush();
                if !v.stderr.is_empty() {
                    let mut err = std::io::stderr().lock();
                    let _ = writeln!(err, "{}", v.stderr);
                }
                return exit_code(v.exit);
            }
            http::Outcome::Untrusted => {
                if std::env::var("AXIOM_GATE_DAEMON_STRICT").as_deref() == Ok("1") {
                    return emit(&deny::render_code(
                        &flags,
                        deny::AUTH_CODE,
                        deny::AUTH_REASON,
                    ));
                }
                eprintln!(
                    "AXIOM GATE WARN {}: {}; falling back to axiom gate",
                    deny::AUTH_CODE,
                    deny::AUTH_REASON
                );
            }
            http::Outcome::NoVerdict => {}
        }
    }

    let launcher = fallback::discover(
        std::env::var_os(fallback::ENV_OVERRIDE),
        std::env::var_os("PATH"),
    );
    if let Some(code) =
        launcher.and_then(|l| fallback::run(&l, &args, input.bytes, fallback::timeout()))
    {
        return exit_code(code);
    }

    // Deliberately fail closed even under --fail-open: that flag relaxes the gate's own
    // judgement of a payload, not the absence of any gate at all.
    emit(&deny::render(&flags, deny::REASON))
}

fn emit(d: &deny::DenyOutput) -> ExitCode {
    eprintln!("{}", d.stderr);
    if let Some(doc) = &d.stdout {
        println!("{doc}");
    }
    exit_code(d.exit)
}

fn main() -> ExitCode {
    let mut argv = std::env::args_os()
        .skip(1)
        .map(|a| a.to_string_lossy().into_owned());
    match argv.next().as_deref() {
        Some("--version" | "-v") => {
            println!("{}", env!("CARGO_PKG_VERSION"));
            ExitCode::SUCCESS
        }
        Some("gate") => gate(argv.collect()),
        _ => {
            eprintln!("{USAGE}");
            ExitCode::from(2)
        }
    }
}
