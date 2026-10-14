//! One `POST /v1/gate` round-trip to the resident daemon over loopback HTTP/1.1.

use crate::pct;
use crate::state::{DAEMON_PROTOCOL, DaemonState};
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream, ToSocketAddrs};
use std::time::{Duration, Instant};

pub const CONNECT_TIMEOUT: Duration = Duration::from_millis(300);
/// DAEMON_CLIENT_TIMEOUT_MS in daemon-proto.ts.
pub const IO_TIMEOUT: Duration = Duration::from_millis(1_500);
const MAX_RESPONSE_BYTES: usize = 16 * 1024 * 1024;

/// What the daemon decided: stdout bytes, stderr text, exit code.
#[derive(Debug, Clone, PartialEq)]
pub struct Verdict {
    pub stdout: Vec<u8>,
    pub stderr: String,
    pub exit: i32,
}

pub fn build_request(
    state: &DaemonState,
    host_header: &str,
    args: &[String],
    cwd: &str,
    stdin_status: &str,
    body: &[u8],
) -> Vec<u8> {
    let mut target = String::from("/v1/gate");
    for (i, a) in args.iter().enumerate() {
        target.push(if i == 0 { '?' } else { '&' });
        target.push_str("a=");
        target.push_str(&pct::encode_component(a));
    }
    let mut head = format!(
        "POST {target} HTTP/1.1\r\nhost: {host_header}\r\nx-axiom-protocol: {DAEMON_PROTOCOL}\r\nx-axiom-cwd: {}\r\nx-axiom-stdin: {stdin_status}\r\ncontent-type: application/octet-stream\r\ncontent-length: {}\r\nconnection: close\r\n",
        pct::encode_header(cwd),
        body.len()
    );
    if let Some(token) = &state.token {
        // A token with CR/LF would let a tampered state file inject headers: refuse to send it.
        if !token.contains(['\r', '\n']) {
            head.push_str(&format!("authorization: Bearer {token}\r\n"));
        }
    }
    head.push_str("\r\n");
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
/// header, truncated body, garbage).
pub fn parse_response(raw: &[u8]) -> Option<Verdict> {
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
    let mut content_length: Option<usize> = None;
    let mut chunked = false;
    for line in lines {
        let (name, value) = line.split_once(':')?;
        let value = value.trim();
        match name.trim().to_ascii_lowercase().as_str() {
            "x-axiom-exit" => {
                exit = value
                    .parse::<u16>()
                    .ok()
                    .filter(|c| *c <= 255)
                    .map(i32::from);
            }
            "x-axiom-stderr" => stderr = pct::decode(value),
            "content-length" => content_length = Some(value.parse().ok()?),
            "transfer-encoding" => chunked = value.to_ascii_lowercase().contains("chunked"),
            _ => {}
        }
    }
    let exit = exit?;
    let stdout = if chunked {
        dechunk(rest)?
    } else if let Some(n) = content_length {
        if rest.len() < n {
            return None;
        }
        rest = &rest[..n];
        rest.to_vec()
    } else {
        rest.to_vec()
    };
    Some(Verdict {
        stdout,
        stderr,
        exit,
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

/// `None` = no verdict (unreachable, timeout, refused, non-200…): the caller falls back.
pub fn round_trip(
    state: &DaemonState,
    args: &[String],
    cwd: &str,
    stdin_status: &str,
    body: &[u8],
) -> Option<Verdict> {
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
    let deadline = Instant::now() + IO_TIMEOUT;
    let remaining = || {
        deadline
            .checked_duration_since(Instant::now())
            .filter(|d| !d.is_zero())
    };
    stream.set_write_timeout(remaining()).ok()?;
    stream
        .write_all(&build_request(
            state,
            &host_header,
            args,
            cwd,
            stdin_status,
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
            Err(_) => return None,
        }
    }
    parse_response(&raw)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn state(token: Option<&str>) -> DaemonState {
        DaemonState {
            protocol: 1.0,
            pid: 1.0,
            host: "127.0.0.1".into(),
            port: 47861,
            version: "2.5.0".into(),
            roots: vec![],
            started_at: None,
            token: token.map(str::to_string),
        }
    }

    #[test]
    fn request_carries_args_headers_and_body() {
        let args = vec!["--stdin".to_string(), "--root".into(), "C:\\my repo".into()];
        let req = build_request(
            &state(Some("tok")),
            "127.0.0.1:47861",
            &args,
            "/a b",
            "ok",
            b"{}",
        );
        let text = String::from_utf8(req).expect("utf8");
        assert!(
            text.starts_with("POST /v1/gate?a=--stdin&a=--root&a=C%3A%5Cmy%20repo HTTP/1.1\r\n")
        );
        assert!(text.contains("\r\nhost: 127.0.0.1:47861\r\n"));
        assert!(text.contains("\r\nx-axiom-protocol: 1\r\n"));
        assert!(text.contains("\r\nx-axiom-cwd: /a%20b\r\n"));
        assert!(text.contains("\r\nx-axiom-stdin: ok\r\n"));
        assert!(text.contains("\r\ncontent-length: 2\r\n"));
        assert!(text.contains("\r\nconnection: close\r\n"));
        assert!(text.contains("\r\nauthorization: Bearer tok\r\n"));
        assert!(!text.to_ascii_lowercase().contains("x-axiom-version"));
        assert!(text.ends_with("\r\n\r\n{}"));
    }

    #[test]
    fn no_token_no_authorization_and_crlf_token_refused() {
        let t =
            String::from_utf8(build_request(&state(None), "h", &[], "/", "timeout", b"")).unwrap();
        assert!(t.starts_with("POST /v1/gate HTTP/1.1\r\n"));
        assert!(!t.contains("authorization"));
        let t = String::from_utf8(build_request(
            &state(Some("a\r\nx-evil: 1")),
            "h",
            &[],
            "/",
            "ok",
            b"",
        ))
        .unwrap();
        assert!(!t.contains("authorization") && !t.contains("x-evil"));
    }

    #[test]
    fn parses_a_200_verdict() {
        let raw = b"HTTP/1.1 200 OK\r\nX-Axiom-Exit: 2\r\nx-axiom-stderr: AXIOM%20GATE%20DENY%20ERR_X%3A%20no%0Aline2\r\nContent-Length: 4\r\nConnection: close\r\n\r\n{\"a\"}trailing";
        let v = parse_response(raw).expect("verdict");
        assert_eq!(v.exit, 2);
        assert_eq!(v.stderr, "AXIOM GATE DENY ERR_X: no\nline2");
        assert_eq!(v.stdout, b"{\"a\"");
    }

    #[test]
    fn parses_chunked_and_empty_bodies() {
        let raw = b"HTTP/1.1 200 OK\r\nx-axiom-exit: 0\r\nTransfer-Encoding: chunked\r\n\r\n3\r\nabc\r\n2;ext\r\nde\r\n0\r\n\r\n";
        assert_eq!(parse_response(raw).expect("verdict").stdout, b"abcde");
        let raw = b"HTTP/1.1 200 OK\r\nx-axiom-exit: 0\r\ncontent-length: 0\r\n\r\n";
        let v = parse_response(raw).expect("verdict");
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
        let mut s = state(None);
        s.host = "10.1.2.3".into();
        assert!(loopback_addrs(&s).is_empty());
        s.host = "127.0.0.1".into();
        assert_eq!(loopback_addrs(&s).len(), 1);
    }
}
