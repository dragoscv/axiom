//! End-to-end: the built binary against a mock daemon, and the fail-closed path.

use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};
use std::sync::mpsc;
use std::thread;

const BIN: &str = env!("CARGO_BIN_EXE_axiom-hook");

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
    std::fs::write(
        home.join(".axiom").join("daemon.json"),
        format!(
            "{{\"protocol\":1,\"pid\":1,\"host\":\"127.0.0.1\",\"port\":{port},\"version\":\"9.9.9\",\"roots\":[],\"startedAt\":\"x\"{token}}}"
        ),
    )
    .unwrap();
}

fn run(home: &Path, args: &[&str], stdin: &[u8], fallback: &Path) -> Output {
    let mut child = Command::new(BIN)
        .args(args)
        .env("HOME", home)
        .env("USERPROFILE", home)
        .env("AXIOM_HOOK_FALLBACK", fallback)
        // The mock daemon thread shares the test process with parallel spawns; under load it can
        // answer after the 1.5 s production deadline and the client (correctly) falls back.
        .env("AXIOM_HOOK_IO_TIMEOUT_MS", "15000")
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

fn mock_daemon(response: &'static [u8]) -> (u16, mpsc::Receiver<Seen>) {
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
        let mut w = stream;
        w.write_all(response).unwrap();
        tx.send(Seen {
            line: line.trim_end().to_string(),
            headers,
            body,
        })
        .unwrap();
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
    let (port, rx) = mock_daemon(
        b"HTTP/1.1 200 OK\r\nx-axiom-exit: 2\r\nx-axiom-stderr: AXIOM%20GATE%20DENY%20ERR_PATH_DENIED%3A%20no%20(.git/config)%0Asecond\r\ncontent-length: 17\r\nconnection: close\r\n\r\n{\"decision\":\"x\"}\n",
    );
    write_state(&home, port, Some("tok-123"));
    let payload = br#"{"tool_name":"Write","tool_input":{"file_path":".git/config"}}"#;
    let out = run(
        &home,
        &["gate", "--stdin", "--format", "cline", "--root", "my dir"],
        payload,
        &home.join("missing-cli.js"),
    );
    let seen = rx.recv().unwrap();
    assert_eq!(
        seen.line,
        "POST /v1/gate?a=--stdin&a=--format&a=cline&a=--root&a=my%20dir HTTP/1.1"
    );
    assert_eq!(seen.header("x-axiom-protocol"), Some("1"));
    assert_eq!(seen.header("x-axiom-stdin"), Some("ok"));
    assert_eq!(seen.header("authorization"), Some("Bearer tok-123"));
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
    let (port, rx) =
        mock_daemon(b"HTTP/1.1 200 OK\r\nx-axiom-exit: 0\r\ncontent-length: 0\r\n\r\n");
    write_state(&home, port, None);
    let out = run(&home, &["gate", "--stdin"], b"{}", &home.join("missing"));
    let seen = rx.recv().unwrap();
    assert!(seen.header("authorization").is_none());
    assert_eq!(out.status.code(), Some(0));
    assert_eq!(String::from_utf8_lossy(&out.stdout), "");
    assert_eq!(String::from_utf8_lossy(&out.stderr), "");
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
    rx.recv().unwrap();
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
