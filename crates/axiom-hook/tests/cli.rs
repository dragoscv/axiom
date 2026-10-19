//! End-to-end: the built binary against a mock daemon, and the fail-closed path.

#[path = "../src/sha.rs"]
#[allow(dead_code)]
mod sha;

use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant};

const BIN: &str = env!("CARGO_BIN_EXE_axiom-hook");
const KEY: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

fn temp_home(name: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("axiom-hook-it-{}-{name}", std::process::id()));
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(d.join(".axiom")).unwrap();
    d
}

fn write_state(home: &Path, port: u16, token: Option<&str>) {
    let token = token
        .map(|t| format!(",\"token\":\"{t}\""))
        .unwrap_or_default();
    let file = home.join(".axiom").join("daemon.json");
    std::fs::write(
        &file,
        format!(
            "{{\"protocol\":2,\"pid\":1,\"host\":\"127.0.0.1\",\"port\":{port},\"version\":\"9.9.9\",\"roots\":[],\"startedAt\":\"x\",\"key\":\"{KEY}\"{token}}}"
        ),
    )
    .unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o600)).unwrap();
    }
}

/// `hex(HMAC(KEY, nonce "\n" exit "\n" sha256hex(body)))`, as the daemon computes it.
fn mac(nonce: &str, exit: &str, body: &[u8]) -> String {
    let key = sha::unhex(KEY).unwrap();
    let msg = format!("{nonce}\n{exit}\n{}", sha::hex(&sha::sha256(body)));
    sha::hex(&sha::hmac_sha256(&key, msg.as_bytes()))
}

/// A correctly MAC'd, Content-Length framed 200.
fn signed(seen: &Seen, exit: &str, stderr: &str, body: &[u8]) -> Vec<u8> {
    let nonce = seen.header("x-axiom-nonce").unwrap_or("");
    let mut r = format!(
        "HTTP/1.1 200 OK\r\nx-axiom-exit: {exit}\r\nx-axiom-stderr: {stderr}\r\nx-axiom-mac: {}\r\ncontent-length: {}\r\nconnection: close\r\n\r\n",
        mac(nonce, exit, body),
        body.len()
    )
    .into_bytes();
    r.extend_from_slice(body);
    r
}

fn run(home: &Path, args: &[&str], stdin: &[u8], fallback: &Path) -> Output {
    run_env(home, args, stdin, fallback, &[])
}

fn run_env(
    home: &Path,
    args: &[&str],
    stdin: &[u8],
    fallback: &Path,
    env: &[(&str, &str)],
) -> Output {
    let mut cmd = Command::new(BIN);
    cmd.args(args)
        .env("HOME", home)
        .env("USERPROFILE", home)
        .env("AXIOM_HOOK_FALLBACK", fallback)
        .env_remove("AXIOM_GATE_DAEMON_STRICT")
        .env_remove("AXIOM_HOOK_FALLBACK_TIMEOUT_MS")
        // The mock daemon thread shares the test process with parallel spawns; under load it can
        // answer after the 1.5 s production deadline and the client (correctly) falls back.
        .env("AXIOM_HOOK_IO_TIMEOUT_MS", "15000");
    for (k, v) in env {
        cmd.env(k, v);
    }
    let mut child = cmd
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn axiom-hook");
    child.stdin.take().unwrap().write_all(stdin).unwrap();
    child.wait_with_output().unwrap()
}

/// What the mock saw: request line, lowercased headers, body.
struct Seen {
    line: String,
    headers: Vec<(String, String)>,
    body: Vec<u8>,
}

impl Seen {
    fn header(&self, k: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(n, _)| n == k)
            .map(|(_, v)| v.as_str())
    }
}

type Responder = Box<dyn Fn(&Seen) -> Vec<u8> + Send>;

/// The request the mock saw — bounded, so a client that never connects fails instead of hanging.
fn got(rx: &mpsc::Receiver<Seen>) -> Seen {
    rx.recv_timeout(Duration::from_secs(30))
        .expect("the client never reached the mock daemon")
}

fn mock_daemon(response: &'static [u8]) -> (u16, mpsc::Receiver<Seen>) {
    mock_daemon_with(Box::new(move |_| response.to_vec()))
}

fn mock_daemon_with(respond: Responder) -> (u16, mpsc::Receiver<Seen>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let (tx, rx) = mpsc::channel();
    thread::spawn(move || {
        let (stream, _) = listener.accept().unwrap();
        let mut r = BufReader::new(stream.try_clone().unwrap());
        let mut line = String::new();
        r.read_line(&mut line).unwrap();
        let mut headers = Vec::new();
        loop {
            let mut h = String::new();
            r.read_line(&mut h).unwrap();
            let h = h.trim_end();
            if h.is_empty() {
                break;
            }
            let (k, v) = h.split_once(':').unwrap();
            headers.push((k.trim().to_ascii_lowercase(), v.trim().to_string()));
        }
        let len: usize = headers
            .iter()
            .find(|(k, _)| k == "content-length")
            .map(|(_, v)| v.parse().unwrap())
            .unwrap_or(0);
        let mut body = vec![0; len];
        r.read_exact(&mut body).unwrap();
        let seen = Seen {
            line: line.trim_end().to_string(),
            headers,
            body,
        };
        let mut w = stream;
        w.write_all(&respond(&seen)).unwrap();
        let _ = w.flush();
        drop(w);
        tx.send(seen).unwrap();
    });
    (port, rx)
}

#[test]
fn version_prints_crate_version() {
    let out = Command::new(BIN).arg("--version").output().unwrap();
    assert!(out.status.success());
    assert_eq!(
        String::from_utf8_lossy(&out.stdout).trim(),
        env!("CARGO_PKG_VERSION")
    );
}

#[test]
fn unknown_verb_is_a_usage_error() {
    for args in [&["nope"][..], &[]] {
        let out = Command::new(BIN).args(args).output().unwrap();
        assert_eq!(out.status.code(), Some(2));
        assert!(String::from_utf8_lossy(&out.stderr).contains("usage: axiom-hook"));
        assert!(out.stdout.is_empty());
    }
}

#[test]
fn daemon_verdict_is_relayed_exactly() {
    let home = temp_home("daemon");
    let (port, rx) = mock_daemon_with(Box::new(|s| {
        signed(
            s,
            "2",
            "AXIOM%20GATE%20DENY%20ERR_PATH_DENIED%3A%20no%20(.git/config)%0Asecond",
            b"{\"decision\":\"x\"}\n",
        )
    }));
    write_state(&home, port, Some("tok-123"));
    let payload = br#"{"tool_name":"Write","tool_input":{"file_path":".git/config"}}"#;
    let out = run(
        &home,
        &["gate", "--stdin", "--format", "cline", "--deny-exit", "2"],
        payload,
        &home.join("missing-cli.js"),
    );
    let seen = got(&rx);
    assert_eq!(
        seen.line,
        "POST /v1/gate?a=--stdin&a=--format&a=cline&a=--deny-exit&a=2 HTTP/1.1"
    );
    assert_eq!(seen.header("x-axiom-protocol"), Some("2"));
    assert_eq!(seen.header("x-axiom-stdin"), Some("ok"));
    // Protocol 2 never sends the bearer: the MAC authenticates the daemon instead.
    assert!(seen.header("authorization").is_none());
    let nonce = seen.header("x-axiom-nonce").expect("nonce");
    assert!(nonce.len() >= 16 && nonce.bytes().all(|b| b.is_ascii_alphanumeric()));
    assert_eq!(seen.header("connection"), Some("close"));
    assert_eq!(
        seen.header("host"),
        Some(format!("127.0.0.1:{port}").as_str())
    );
    assert!(seen.header("x-axiom-version").is_none());
    assert!(seen.header("x-axiom-cwd").is_some_and(|c| !c.is_empty()));
    assert_eq!(seen.body, payload);

    assert_eq!(
        out.status.code(),
        Some(2),
        "stdout={} stderr={}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    );
    assert_eq!(out.stdout, b"{\"decision\":\"x\"}\n");
    assert_eq!(
        String::from_utf8_lossy(&out.stderr),
        "AXIOM GATE DENY ERR_PATH_DENIED: no (.git/config)\nsecond\n"
    );
}

#[test]
fn allow_verdict_has_empty_stdout() {
    let home = temp_home("allow");
    let (port, rx) = mock_daemon_with(Box::new(|s| signed(s, "0", "", b"")));
    write_state(&home, port, None);
    let out = run(&home, &["gate", "--stdin"], b"{}", &home.join("missing"));
    let seen = got(&rx);
    assert!(seen.header("authorization").is_none());
    assert_eq!(out.status.code(), Some(0));
    assert_eq!(String::from_utf8_lossy(&out.stdout), "");
    assert_eq!(String::from_utf8_lossy(&out.stderr), "");
}

const CLINE_DENY: &str = r#"{"cancel":true,"errorMessage":"gate daemon unreachable and no axiom CLI found (fail-closed)"}"#;

#[test]
fn squatter_allow_without_mac_is_not_trusted() {
    // The P0: any local process on the daemon port answering "exit 0" used to be an allow.
    let home = temp_home("squat");
    let (port, rx) = mock_daemon(
        b"HTTP/1.1 200 OK\r\nx-axiom-exit: 0\r\ncontent-length: 0\r\nconnection: close\r\n\r\n",
    );
    write_state(&home, port, None);
    let out = run(
        &home,
        &["gate", "--stdin", "--format", "cline", "--deny-exit", "2"],
        b"{}",
        &home.join("missing.js"),
    );
    got(&rx);
    assert_eq!(out.status.code(), Some(2));
    assert_eq!(String::from_utf8_lossy(&out.stdout).trim(), CLINE_DENY);
    assert!(String::from_utf8_lossy(&out.stderr).contains("ERR_DAEMON_AUTH"));
}

#[test]
fn mac_mismatch_falls_back() {
    let home = temp_home("badmac");
    let (port, rx) = mock_daemon_with(Box::new(|s| {
        // MAC'd for exit 2 but claims exit 0: a forged allow.
        let good = signed(s, "2", "", b"");
        String::from_utf8(good)
            .unwrap()
            .replacen("x-axiom-exit: 2", "x-axiom-exit: 0", 1)
            .into_bytes()
    }));
    write_state(&home, port, None);
    let out = run(
        &home,
        &["gate", "--stdin", "--format", "cline", "--deny-exit", "2"],
        b"{}",
        &home.join("missing.js"),
    );
    got(&rx);
    assert_eq!(out.status.code(), Some(2));
    assert_eq!(String::from_utf8_lossy(&out.stdout).trim(), CLINE_DENY);
}

#[test]
fn strict_mode_denies_an_unauthenticated_answer_with_err_daemon_auth() {
    let home = temp_home("strict");
    let (port, rx) = mock_daemon(
        b"HTTP/1.1 200 OK\r\nx-axiom-exit: 0\r\ncontent-length: 0\r\nconnection: close\r\n\r\n",
    );
    write_state(&home, port, None);
    let out = run_env(
        &home,
        &["gate", "--stdin", "--format", "cline"],
        b"{}",
        &home.join("missing.js"),
        &[("AXIOM_GATE_DAEMON_STRICT", "1")],
    );
    got(&rx);
    assert_eq!(out.status.code(), Some(0));
    let stdout = String::from_utf8_lossy(&out.stdout);
    assert!(stdout.contains("\"cancel\":true"), "{stdout}");
    assert!(
        String::from_utf8_lossy(&out.stderr).contains("AXIOM GATE DENY ERR_DAEMON_AUTH"),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
}

#[test]
fn close_delimited_body_falls_back() {
    let home = temp_home("noframe");
    let (port, rx) = mock_daemon_with(Box::new(|s| {
        let nonce = s.header("x-axiom-nonce").unwrap_or("").to_string();
        format!(
            "HTTP/1.1 200 OK\r\nx-axiom-exit: 0\r\nx-axiom-mac: {}\r\nconnection: close\r\n\r\n",
            mac(&nonce, "0", b"")
        )
        .into_bytes()
    }));
    write_state(&home, port, None);
    let out = run(
        &home,
        &["gate", "--stdin", "--format", "cline", "--deny-exit", "2"],
        b"{}",
        &home.join("missing.js"),
    );
    got(&rx);
    assert_eq!(out.status.code(), Some(2));
    assert_eq!(String::from_utf8_lossy(&out.stdout).trim(), CLINE_DENY);
}

#[test]
fn exit_codes_outside_0_1_2_fall_back() {
    let home = temp_home("exit5");
    let (port, rx) = mock_daemon_with(Box::new(|s| signed(s, "5", "", b"")));
    write_state(&home, port, None);
    let out = run(
        &home,
        &["gate", "--stdin", "--format", "cline", "--deny-exit", "2"],
        b"{}",
        &home.join("missing.js"),
    );
    got(&rx);
    assert_eq!(out.status.code(), Some(2));
    assert_eq!(String::from_utf8_lossy(&out.stdout).trim(), CLINE_DENY);
}

#[test]
fn protocol_1_state_file_is_ignored() {
    let home = temp_home("p1");
    let (port, _rx) = mock_daemon(
        b"HTTP/1.1 200 OK\r\nx-axiom-exit: 0\r\ncontent-length: 0\r\nconnection: close\r\n\r\n",
    );
    std::fs::write(
        home.join(".axiom").join("daemon.json"),
        format!(
            "{{\"protocol\":1,\"pid\":1,\"host\":\"127.0.0.1\",\"port\":{port},\"version\":\"9.9.9\",\"roots\":[],\"startedAt\":\"x\"}}"
        ),
    )
    .unwrap();
    let out = run(
        &home,
        &["gate", "--stdin", "--format", "cline"],
        b"{}",
        &home.join("missing.js"),
    );
    assert_eq!(String::from_utf8_lossy(&out.stdout).trim(), CLINE_DENY);
}

#[test]
fn fallback_that_hangs_is_killed_and_fails_closed() {
    if !node_on_path() {
        eprintln!("node not on PATH: skipping fallback timeout test");
        return;
    }
    let home = temp_home("fbhang");
    let js = home.join("hang-cli.js");
    std::fs::write(&js, "setTimeout(() => process.exit(0), 60000);").unwrap();
    let t0 = Instant::now();
    let out = run_env(
        &home,
        &["gate", "--stdin", "--format", "cline", "--deny-exit", "2"],
        b"{}",
        &js,
        &[("AXIOM_HOOK_FALLBACK_TIMEOUT_MS", "800")],
    );
    assert!(
        t0.elapsed() < Duration::from_secs(20),
        "took {:?}",
        t0.elapsed()
    );
    assert_eq!(out.status.code(), Some(2));
    assert_eq!(String::from_utf8_lossy(&out.stdout).trim(), CLINE_DENY);
}

#[test]
fn non_200_falls_back_then_fails_closed() {
    let home = temp_home("409");
    let (port, rx) = mock_daemon(b"HTTP/1.1 409 Conflict\r\ncontent-length: 0\r\n\r\n");
    write_state(&home, port, None);
    let out = run(
        &home,
        &["gate", "--stdin", "--format", "cline"],
        b"{}",
        &home.join("missing.js"),
    );
    got(&rx);
    assert_eq!(out.status.code(), Some(0));
    assert_eq!(
        String::from_utf8_lossy(&out.stdout).trim(),
        r#"{"cancel":true,"errorMessage":"gate daemon unreachable and no axiom CLI found (fail-closed)"}"#
    );
}

fn closed_port() -> u16 {
    // Bind then drop: nothing listens there afterwards.
    TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port()
}

#[test]
fn daemon_down_and_no_cli_fails_closed_cline() {
    let home = temp_home("down-cline");
    write_state(&home, closed_port(), None);
    let out = run(
        &home,
        &["gate", "--stdin", "--format", "cline"],
        b"{}",
        &home.join("nope.js"),
    );
    assert_eq!(out.status.code(), Some(0));
    assert_eq!(
        String::from_utf8_lossy(&out.stdout).trim(),
        r#"{"cancel":true,"errorMessage":"gate daemon unreachable and no axiom CLI found (fail-closed)"}"#
    );
    assert_eq!(
        String::from_utf8_lossy(&out.stderr).trim(),
        "AXIOM GATE DENY ERR_INTERNAL: gate daemon unreachable and no axiom CLI found (fail-closed)"
    );
}

#[test]
fn daemon_down_and_no_cli_fails_closed_windsurf() {
    let home = temp_home("down-ws");
    write_state(&home, closed_port(), None);
    let out = run(
        &home,
        &["gate", "--stdin", "--format", "windsurf"],
        b"{}",
        &home.join("nope"),
    );
    assert_eq!(out.status.code(), Some(2));
    assert!(out.stdout.is_empty());
    assert!(String::from_utf8_lossy(&out.stderr).contains("AXIOM GATE DENY ERR_INTERNAL"));
}

#[test]
fn no_state_file_and_deny_exit_2() {
    let home = temp_home("nostate");
    std::fs::remove_dir_all(home.join(".axiom")).unwrap();
    let out = run(
        &home,
        &["gate", "--stdin", "--deny-exit", "2"],
        b"{}",
        &home.join("nope"),
    );
    assert_eq!(out.status.code(), Some(2));
    let s = String::from_utf8_lossy(&out.stdout);
    assert!(s.contains(
        r#""hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny""#
    ));
    assert!(s.contains(r#""permissionDecision":"deny","permissionDecisionReason":"#));
}

#[test]
fn fallback_cli_receives_args_and_stdin() {
    // A fake `axiom` that echoes its argv and stdin, run through the override (node + .js).
    if !node_on_path() {
        eprintln!("node not on PATH: skipping fallback relay test");
        return;
    }
    let home = temp_home("fb");
    let js = home.join("fake-cli.js");
    std::fs::write(
        &js,
        "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{process.stdout.write(JSON.stringify({argv:process.argv.slice(2),stdin:s}));process.exit(3)});",
    )
    .unwrap();
    let out = run(
        &home,
        &["gate", "--stdin", "--format", "codex"],
        b"{\"p\":1}",
        &js,
    );
    assert_eq!(
        out.status.code(),
        Some(3),
        "stderr: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    assert_eq!(
        String::from_utf8_lossy(&out.stdout),
        r#"{"argv":["gate","--stdin","--format","codex"],"stdin":"{\"p\":1}"}"#
    );
}

fn node_on_path() -> bool {
    let name = if cfg!(windows) { "node.exe" } else { "node" };
    std::env::var_os("PATH")
        .is_some_and(|p| std::env::split_paths(&p).any(|d| d.join(name).is_file()))
}
