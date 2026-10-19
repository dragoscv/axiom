//! `~/.axiom/daemon.json` (mirrors `DaemonState` / `isState` in packages/mcp/src/daemon-proto.ts).
//!
//! Protocol 2: the file carries the per-start MAC `key` (64 hex chars). On POSIX a file that
//! group/other can access is refused (a readable key authenticates nothing). The `pid` field is
//! not checked here — std has no portable liveness probe; the MAC is what makes a stale file or
//! a squatter on the recorded port harmless (no verdict → spawn fallback).

use crate::json::{self, Json};
use crate::sha;
use std::path::PathBuf;

pub const DAEMON_PROTOCOL: u32 = 2;
pub const STATE_DIR: &str = ".axiom";
pub const STATE_FILE: &str = "daemon.json";

#[derive(Debug, Clone, PartialEq)]
pub struct DaemonState {
    pub protocol: f64,
    pub pid: f64,
    pub host: String,
    pub port: u16,
    pub version: String,
    pub roots: Vec<String>,
    pub started_at: Option<String>,
    /// 32-byte MAC key (decoded from the 64-hex `key` field).
    pub key: Vec<u8>,
}

/// USERPROFILE on Windows, HOME elsewhere (same as Node's `os.homedir()` in practice).
pub fn home_dir() -> Option<PathBuf> {
    let var = if cfg!(windows) { "USERPROFILE" } else { "HOME" };
    std::env::var_os(var)
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
}

pub fn state_path(home: &std::path::Path) -> PathBuf {
    home.join(STATE_DIR).join(STATE_FILE)
}

/// `None` when the document is malformed or fails the same shape checks as `isState`.
pub fn parse_state(text: &str) -> Option<DaemonState> {
    let v = json::parse(text)?;
    let num = |k: &str| match v.get(k) {
        Some(Json::Num(n)) => Some(*n),
        _ => None,
    };
    let string = |k: &str| match v.get(k) {
        Some(Json::Str(s)) => Some(s.clone()),
        _ => None,
    };
    let protocol = num("protocol")?;
    let pid = num("pid")?;
    let host = string("host")?;
    let port_f = num("port")?;
    if port_f.fract() != 0.0 || port_f <= 0.0 || port_f >= 65_536.0 {
        return None;
    }
    let version = string("version")?;
    let roots = match v.get("roots")? {
        Json::Arr(items) => items
            .iter()
            .filter_map(|r| match r {
                Json::Str(s) => Some(s.clone()),
                _ => None,
            })
            .collect(),
        _ => return None,
    };
    let key_hex = string("key")?;
    if key_hex.len() != 64 || key_hex.bytes().any(|b| b.is_ascii_uppercase()) {
        return None;
    }
    let key = sha::unhex(&key_hex)?;
    Some(DaemonState {
        protocol,
        pid,
        host,
        port: port_f as u16,
        version,
        roots,
        started_at: string("startedAt"),
        key,
    })
}

#[cfg(unix)]
fn private_enough(p: &std::path::Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    std::fs::metadata(p)
        .map(|m| m.permissions().mode() & 0o077 == 0)
        .unwrap_or(false)
}

#[cfg(not(unix))]
fn private_enough(_: &std::path::Path) -> bool {
    true // the daemon restricts the ACL with icacls; NTFS ACLs are not inspectable with std
}

pub fn read_state() -> Option<DaemonState> {
    let path = state_path(&home_dir()?);
    if !private_enough(&path) {
        return None;
    }
    let text = std::fs::read_to_string(path).ok()?;
    parse_state(&text)
}

#[cfg(test)]
mod tests {
    use super::*;

    const GOOD: &str = r#"{"protocol":2,"pid":4242,"host":"127.0.0.1","port":47861,"version":"2.5.0","roots":["E:\\gh\\axiom"],"startedAt":"2026-10-14T10:00:00.000Z","key":"00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff"}"#;

    #[test]
    fn parses_a_valid_state() {
        let s = parse_state(GOOD).expect("valid");
        assert_eq!(s.host, "127.0.0.1");
        assert_eq!(s.port, 47861);
        assert_eq!(s.roots, vec!["E:\\gh\\axiom".to_string()]);
        assert_eq!(s.protocol, 2.0);
        assert_eq!(s.key.len(), 32);
        assert_eq!(s.key[1], 0x11);
        assert_eq!(s.started_at.as_deref(), Some("2026-10-14T10:00:00.000Z"));
    }

    #[test]
    fn rejects_bad_shapes() {
        let key = "\"key\":\"00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff\"";
        let mut cases: Vec<(String, String)> = [
            ("\"port\":47861", "\"port\":0"),
            ("\"port\":47861", "\"port\":65536"),
            ("\"port\":47861", "\"port\":1.5"),
            ("\"port\":47861", "\"port\":\"47861\""),
            ("\"host\":\"127.0.0.1\"", "\"host\":1"),
            ("\"roots\":[\"E:\\\\gh\\\\axiom\"]", "\"roots\":\"x\""),
            ("\"pid\":4242,", ""),
            ("\"version\":\"2.5.0\"", "\"version\":2"),
        ]
        .iter()
        .map(|(a, b)| (a.to_string(), b.to_string()))
        .collect();
        cases.extend([
            (",".to_string() + key, String::new()),
            (key.to_string(), "\"key\":\"abcd\"".to_string()),
            (key.to_string(), key.replace("ff\"", "FF\"")),
            (key.to_string(), key.replace("ff\"", "zz\"")),
            (key.to_string(), "\"key\":5".to_string()),
        ]);
        for (from, to) in cases {
            let doc = GOOD.replace(from.as_str(), to.as_str());
            assert_ne!(doc, GOOD, "replacement {from:?} must apply");
            assert_eq!(parse_state(&doc), None, "{doc} must be rejected");
        }
        assert_eq!(parse_state("not json"), None);
        assert_eq!(parse_state("[]"), None);
    }
}
