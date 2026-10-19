//! One `POST /v1/gate` round-trip to the resident daemon over loopback HTTP/1.1.
//!
//! Protocol 2: every request carries a fresh `x-axiom-nonce`; a verdict counts only when its
//! `x-axiom-mac` equals `hex(HMAC-SHA256(key, nonce "\n" exit "\n" sha256hex(body)))`, the body is
//! framed (Content-Length or chunked — a close-delimited body may be truncated) and the exit code
//! is 0, 1 or 2. No bearer token is sent.

use crate::pct;
use crate::sha;
use crate::state::{DAEMON_PROTOCOL, DaemonState};
use std::collections::hash_map::RandomState;
use std::hash::{BuildHasher, Hasher};
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream, ToSocketAddrs};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

pub const CONNECT_TIMEOUT: Duration = Duration::from_millis(300);
/// DAEMON_CLIENT_TIMEOUT_MS in daemon-proto.ts.
pub const IO_TIMEOUT: Duration = Duration::from_millis(1_500);
/// Override for slow or loaded machines (and the integration tests): 100..=30000 ms, else ignored.
pub const ENV_IO_TIMEOUT: &str = "AXIOM_HOOK_IO_TIMEOUT_MS";

fn io_timeout() -> Duration {
    std::env::var(ENV_IO_TIMEOUT)
        .ok()
        .and_then(|v| v.trim().parse::<u64>().ok())
        .filter(|ms| (100..=30_000).contains(ms))
        .map_or(IO_TIMEOUT, Duration::from_millis)
}
const MAX_RESPONSE_BYTES: usize = 16 * 1024 * 1024;

/// What the daemon decided: stdout bytes, stderr text, exit code.
#[derive(Debug, Clone, PartialEq)]
pub struct Verdict {
    pub stdout: Vec<u8>,
    pub stderr: String,
    pub exit: i32,
}

/// A parsed 200 before authentication.
#[derive(Debug, Clone, PartialEq)]
pub struct Answer {
    pub verdict: Verdict,
    pub mac: Option<String>,
}

/// Result of one round trip.
#[derive(Debug, Clone, PartialEq)]
pub enum Outcome {
    /// Authenticated verdict.
    Verdict(Verdict),
    /// No verdict (unreachable, timeout, non-200, garbage, unframed): fall back.
    NoVerdict,
    /// A well-formed 200 whose MAC does not verify: someone else answered. Fall back (or deny
    /// under `AXIOM_GATE_DAEMON_STRICT=1`).
    Untrusted,
}

/// 32 hex chars, unique per call. Not secret: it only has to make a recorded answer useless.
/// `RandomState` keys come from the OS RNG (then differ per instance); mixed with time + pid.
pub fn nonce() -> String {
    let t = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let mut out = [0u8; 16];
    for (i, half) in out.chunks_exact_mut(8).enumerate() {
        let mut h = RandomState::new().build_hasher();
        h.write_u128(t);
        h.write_u32(std::process::id());
        h.write_usize(i);
        half.copy_from_slice(&h.finish().to_le_bytes());
    }
    sha::hex(&out)
}

pub fn expected_mac(key: &[u8], nonce: &str, exit: i32, body: &[u8]) -> String {
    let msg = format!("{nonce}\n{exit}\n{}", sha::hex(&sha::sha256(body)));
    sha::hex(&sha::hmac_sha256(key, msg.as_bytes()))
}

/// Authenticate a parsed answer against our nonce.
pub fn authenticate(state: &DaemonState, nonce: &str, a: Answer) -> Outcome {
    let Some(mac) = a.mac.as_deref().and_then(sha::unhex) else {
        return Outcome::Untrusted;
    };
    let want = sha::unhex(&expected_mac(
        &state.key,
        nonce,
        a.verdict.exit,
        &a.verdict.stdout,
    ))
    .unwrap_or_default();
    if state.key.len() == 32 && sha::ct_eq(&want, &mac) {
        Outcome::Verdict(a.verdict)
    } else {
        Outcome::Untrusted
    }
}

pub fn build_request(
    host_header: &str,
    args: &[String],
    cwd: &str,
    stdin_status: &str,
    nonce: &str,
    body: &[u8],
) -> Vec<u8> {
    let mut target = String::from("/v1/gate");
    for (i, a) in args.iter().enumerate() {
        target.push(if i == 0 { '?' } else { '&' });
        target.push_str("a=");
        target.push_str(&pct::encode_component(a));
    }
    let head = format!(
        "POST {target} HTTP/1.1\r\nhost: {host_header}\r\nx-axiom-protocol: {DAEMON_PROTOCOL}\r\nx-axiom-nonce: {nonce}\r\nx-axiom-cwd: {}\r\nx-axiom-stdin: {stdin_status}\r\ncontent-type: application/octet-stream\r\ncontent-length: {}\r\nconnection: close\r\n\r\n",
        pct::encode_header(cwd),
        body.len()
    );
    let mut req = head.into_bytes();
    req.extend_from_slice(body);
    req
}

fn find(hay: &[u8], needle: &[u8]) -> Option<usize> {
    hay.windows(needle.len()).position(|w| w == needle)
}

fn dechunk(mut b: &[u8]) -> Option<Vec<u8>> {
    let mut out = Vec::new();
    loop {
        let eol = find(b, b"\r\n")?;
        let size_txt = std::str::from_utf8(&b[..eol]).ok()?;
        let size_txt = size_txt.split(';').next()?.trim();
        let size = usize::from_str_radix(size_txt, 16).ok()?;
        b = &b[eol + 2..];
        if size == 0 {
            return Some(out);
        }
        if b.len() < size + 2 || &b[size..size + 2] != b"\r\n" {
            return None;
        }
        out.extend_from_slice(&b[..size]);
        b = &b[size + 2..];
    }
}

/// Parse a complete HTTP/1.1 response. `None` = no verdict (non-200, missing/invalid exit
/// header — only 0, 1, 2 —, unframed or truncated body, garbage). The MAC is checked separately.
pub fn parse_response(raw: &[u8]) -> Option<Answer> {
    let split = find(raw, b"\r\n\r\n")?;
    let head = std::str::from_utf8(&raw[..split]).ok()?;
    let mut rest = &raw[split + 4..];
    let mut lines = head.split("\r\n");
    let status_line = lines.next()?;
    let mut parts = status_line.splitn(3, ' ');
    if !parts.next()?.starts_with("HTTP/1.") || parts.next()? != "200" {
        return None;
    }
    let mut exit: Option<i32> = None;
    let mut stderr = String::new();
    let mut mac: Option<String> = None;
    let mut content_length: Option<usize> = None;
    let mut chunked = false;
    for line in lines {
        let (name, value) = line.split_once(':')?;
        let value = value.trim();
        match name.trim().to_ascii_lowercase().as_str() {
            "x-axiom-exit" => {
                exit = match value {
                    "0" => Some(0),
                    "1" => Some(1),
                    "2" => Some(2),
                    _ => None,
                };
            }
            "x-axiom-stderr" => stderr = pct::decode(value),
            "x-axiom-mac" => mac = Some(value.to_string()),
            "content-length" => content_length = Some(value.parse().ok()?),
            "transfer-encoding" => chunked = value.to_ascii_lowercase().contains("chunked"),
            _ => {}
        }
    }
    let exit = exit?;
    let stdout = if chunked {
        dechunk(rest)?
    } else {
        // No Content-Length → close-delimited: a cut connection is indistinguishable from the end.
        let n = content_length?;
        if rest.len() < n {
            return None;
        }
        rest = &rest[..n];
        rest.to_vec()
    };
    Some(Answer {
        verdict: Verdict {
            stdout,
            stderr,
            exit,
        },
        mac,
    })
}

fn loopback_addrs(state: &DaemonState) -> Vec<SocketAddr> {
    // The daemon only binds loopback; a state file pointing elsewhere is never trusted (it
    // would ship the payload and the token off the machine).
    (state.host.as_str(), state.port)
        .to_socket_addrs()
        .map(|it| it.filter(|a| a.ip().is_loopback()).collect())
        .unwrap_or_default()
}

pub fn round_trip(
    state: &DaemonState,
    args: &[String],
    cwd: &str,
    stdin_status: &str,
    body: &[u8],
) -> Outcome {
    let nonce = nonce();
    match exchange(state, args, cwd, stdin_status, &nonce, body) {
        Some(a) => authenticate(state, &nonce, a),
        None => Outcome::NoVerdict,
    }
}

fn exchange(
    state: &DaemonState,
    args: &[String],
    cwd: &str,
    stdin_status: &str,
    nonce: &str,
    body: &[u8],
) -> Option<Answer> {
    let addr = loopback_addrs(state).into_iter().find_map(|a| {
        TcpStream::connect_timeout(&a, CONNECT_TIMEOUT)
            .ok()
            .map(|s| (a, s))
    });
    let (addr, mut stream) = addr?;
    let host_header = match addr {
        SocketAddr::V4(v4) => format!("{}:{}", v4.ip(), v4.port()),
        SocketAddr::V6(v6) => format!("[{}]:{}", v6.ip(), v6.port()),
    };
    let _ = stream.set_nodelay(true);
    let deadline = Instant::now() + io_timeout();
    let remaining = || {
        deadline
            .checked_duration_since(Instant::now())
            .filter(|d| !d.is_zero())
    };
    stream.set_write_timeout(remaining()).ok()?;
    stream
        .write_all(&build_request(
            &host_header,
            args,
            cwd,
            stdin_status,
            nonce,
            body,
        ))
        .ok()?;
    let mut raw = Vec::with_capacity(4096);
    let mut buf = [0u8; 16 * 1024];
    loop {
        stream.set_read_timeout(Some(remaining()?)).ok()?;
        match stream.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => {
                raw.extend_from_slice(&buf[..n]);
                if raw.len() > MAX_RESPONSE_BYTES {
                    return None;
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => {}
            // Windows answers a peer's close with RST when unread bytes remain in either buffer,
            // so a fully received response can end in ConnectionReset/Aborted instead of EOF.
            // Keep it when it is complete (parse_response requires the full Content-Length or
            // chunked body); anything partial still means "no verdict".
            Err(_) => return parse_response(&raw),
        }
    }
    parse_response(&raw)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn v(raw: &[u8]) -> Option<(i32, Vec<u8>)> {
        parse_response(raw).map(|a| (a.verdict.exit, a.verdict.stdout))
    }

    #[test]
    fn framing_is_required() {
        let whole = b"HTTP/1.1 200 OK\r\nx-axiom-exit: 2\r\ncontent-length: 3\r\n\r\nabc";
        assert_eq!(v(whole), Some((2, b"abc".to_vec())));
        let cut = b"HTTP/1.1 200 OK\r\nx-axiom-exit: 2\r\ncontent-length: 9\r\n\r\nabc";
        assert!(v(cut).is_none(), "short body is no verdict");
        let unframed = b"HTTP/1.1 200 OK\r\nx-axiom-exit: 0\r\n\r\nabc";
        assert!(
            v(unframed).is_none(),
            "close-delimited body may be truncated"
        );
        assert!(v(b"HTTP/1.1 200 OK\r\nx-axi").is_none());
    }

    fn state() -> DaemonState {
        DaemonState {
            protocol: 2.0,
            pid: 1.0,
            host: "127.0.0.1".into(),
            port: 47861,
            version: "2.5.0".into(),
            roots: vec![],
            started_at: None,
            key: vec![7u8; 32],
        }
    }

    #[test]
    fn request_carries_args_headers_nonce_and_body() {
        let args = vec!["--stdin".to_string(), "--root".into(), "C:\\my repo".into()];
        let req = build_request("127.0.0.1:47861", &args, "/a b", "ok", "n0nce", b"{}");
        let text = String::from_utf8(req).expect("utf8");
        assert!(
            text.starts_with("POST /v1/gate?a=--stdin&a=--root&a=C%3A%5Cmy%20repo HTTP/1.1\r\n")
        );
        assert!(text.contains("\r\nhost: 127.0.0.1:47861\r\n"));
        assert!(text.contains("\r\nx-axiom-protocol: 2\r\n"));
        assert!(text.contains("\r\nx-axiom-nonce: n0nce\r\n"));
        assert!(text.contains("\r\nx-axiom-cwd: /a%20b\r\n"));
        assert!(text.contains("\r\nx-axiom-stdin: ok\r\n"));
        assert!(text.contains("\r\ncontent-length: 2\r\n"));
        assert!(text.contains("\r\nconnection: close\r\n"));
        assert!(!text.contains("authorization"));
        assert!(!text.to_ascii_lowercase().contains("x-axiom-version"));
        assert!(text.ends_with("\r\n\r\n{}"));
    }

    #[test]
    fn nonces_are_unique_hex() {
        let a = nonce();
        let b = nonce();
        assert_eq!(a.len(), 32);
        assert!(a.bytes().all(|c| c.is_ascii_hexdigit()));
        assert_ne!(a, b);
    }

    #[test]
    fn mac_is_checked_against_nonce_exit_and_body() {
        let st = state();
        let body = b"{\"x\":1}".to_vec();
        let good = expected_mac(&st.key, "nnnn", 2, &body);
        let ans = |mac: Option<String>, exit: i32, stdout: Vec<u8>| Answer {
            verdict: Verdict {
                stdout,
                stderr: String::new(),
                exit,
            },
            mac,
        };
        assert!(matches!(
            authenticate(&st, "nnnn", ans(Some(good.clone()), 2, body.clone())),
            Outcome::Verdict(_)
        ));
        assert_eq!(
            authenticate(&st, "other", ans(Some(good.clone()), 2, body.clone())),
            Outcome::Untrusted
        );
        assert_eq!(
            authenticate(&st, "nnnn", ans(Some(good.clone()), 0, body.clone())),
            Outcome::Untrusted
        );
        assert_eq!(
            authenticate(&st, "nnnn", ans(Some(good), 2, b"{}".to_vec())),
            Outcome::Untrusted
        );
        assert_eq!(
            authenticate(&st, "nnnn", ans(None, 2, body.clone())),
            Outcome::Untrusted
        );
        assert_eq!(
            authenticate(&st, "nnnn", ans(Some("zz".into()), 2, body)),
            Outcome::Untrusted
        );
    }

    #[test]
    fn parses_a_200_verdict() {
        let raw = b"HTTP/1.1 200 OK\r\nX-Axiom-Exit: 2\r\nx-axiom-stderr: AXIOM%20GATE%20DENY%20ERR_X%3A%20no%0Aline2\r\nX-Axiom-Mac: abcd\r\nContent-Length: 4\r\nConnection: close\r\n\r\n{\"a\"}trailing";
        let a = parse_response(raw).expect("verdict");
        assert_eq!(a.mac.as_deref(), Some("abcd"));
        let v = a.verdict;
        assert_eq!(v.exit, 2);
        assert_eq!(v.stderr, "AXIOM GATE DENY ERR_X: no\nline2");
        assert_eq!(v.stdout, b"{\"a\"");
    }

    #[test]
    fn parses_chunked_and_empty_bodies() {
        let raw = b"HTTP/1.1 200 OK\r\nx-axiom-exit: 0\r\nTransfer-Encoding: chunked\r\n\r\n3\r\nabc\r\n2;ext\r\nde\r\n0\r\n\r\n";
        assert_eq!(
            parse_response(raw).expect("verdict").verdict.stdout,
            b"abcde"
        );
        let raw = b"HTTP/1.1 200 OK\r\nx-axiom-exit: 0\r\ncontent-length: 0\r\n\r\n";
        let v = parse_response(raw).expect("verdict").verdict;
        assert_eq!((v.stdout.len(), v.stderr.as_str(), v.exit), (0, "", 0));
    }

    #[test]
    fn no_verdict_cases() {
        for raw in [
            &b"HTTP/1.1 409 Conflict\r\nx-axiom-exit: 0\r\ncontent-length: 0\r\n\r\n"[..],
            b"HTTP/1.1 421 Misdirected\r\n\r\n",
            b"HTTP/1.1 200 OK\r\ncontent-length: 0\r\n\r\n",
            b"HTTP/1.1 200 OK\r\nx-axiom-exit: 256\r\n\r\n",
            b"HTTP/1.1 200 OK\r\nx-axiom-exit: -1\r\n\r\n",
            b"HTTP/1.1 200 OK\r\nx-axiom-exit: deny\r\n\r\n",
            b"HTTP/1.1 200 OK\r\nx-axiom-exit: 3\r\ncontent-length: 0\r\n\r\n",
            b"HTTP/1.1 200 OK\r\nx-axiom-exit: 00\r\ncontent-length: 0\r\n\r\n",
            b"HTTP/1.1 200 OK\r\nx-axiom-exit: 0\r\n\r\nclose-delimited",
            b"HTTP/1.1 200 OK\r\nx-axiom-exit: 0\r\ncontent-length: 10\r\n\r\nshort",
            b"HTTP/1.1 200 OK\r\nx-axiom-exit: 0\r\ntransfer-encoding: chunked\r\n\r\nzz\r\n",
            b"HTTP/1.1 200 OK\r\nx-axiom-exit: 0\r\n",
            b"garbage",
            b"",
        ] {
            assert_eq!(
                parse_response(raw),
                None,
                "{:?}",
                String::from_utf8_lossy(raw)
            );
        }
    }

    #[test]
    fn non_loopback_hosts_are_never_contacted() {
        let mut s = state();
        s.host = "10.1.2.3".into();
        assert!(loopback_addrs(&s).is_empty());
        s.host = "127.0.0.1".into();
        assert_eq!(loopback_addrs(&s).len(), 1);
    }
}
