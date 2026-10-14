//! `~/.axiom/daemon.json` (mirrors `DaemonState` / `isState` in packages/mcp/src/daemon-proto.ts).

use crate::json::{self, Json};
use std::path::PathBuf;

pub const DAEMON_PROTOCOL: u32 = 1;
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
    pub token: Option<String>,
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
    let token = match v.get("token") {
        None => None,
        Some(Json::Str(s)) => Some(s.clone()),
        Some(_) => return None,
    };
    Some(DaemonState {
        protocol,
        pid,
        host,
        port: port_f as u16,
        version,
        roots,
        started_at: string("startedAt"),
        token,
    })
}

pub fn read_state() -> Option<DaemonState> {
    let text = std::fs::read_to_string(state_path(&home_dir()?)).ok()?;
    parse_state(&text)
}

#[cfg(test)]
mod tests {
    use super::*;

    const GOOD: &str = r#"{"protocol":1,"pid":4242,"host":"127.0.0.1","port":47861,"version":"2.5.0","roots":["E:\\gh\\axiom"],"startedAt":"2026-10-14T10:00:00.000Z"}"#;

    #[test]
    fn parses_a_valid_state() {
        let s = parse_state(GOOD).expect("valid");
        assert_eq!(s.host, "127.0.0.1");
        assert_eq!(s.port, 47861);
        assert_eq!(s.roots, vec!["E:\\gh\\axiom".to_string()]);
        assert_eq!(s.token, None);
        assert_eq!(s.started_at.as_deref(), Some("2026-10-14T10:00:00.000Z"));
    }

    #[test]
    fn reads_the_optional_token() {
        let t = GOOD.replace("\"roots\"", "\"token\":\"s3cr3t\",\"roots\"");
        assert_eq!(
            parse_state(&t).and_then(|s| s.token).as_deref(),
            Some("s3cr3t")
        );
    }

    #[test]
    fn rejects_bad_shapes() {
        for (from, to) in [
            ("\"port\":47861", "\"port\":0"),
            ("\"port\":47861", "\"port\":65536"),
            ("\"port\":47861", "\"port\":1.5"),
            ("\"port\":47861", "\"port\":\"47861\""),
            ("\"host\":\"127.0.0.1\"", "\"host\":1"),
            ("\"roots\":[\"E:\\\\gh\\\\axiom\"]", "\"roots\":\"x\""),
            ("\"pid\":4242,", ""),
            ("\"version\":\"2.5.0\"", "\"version\":2"),
            ("\"roots\"", "\"token\":5,\"roots\""),
        ] {
            let doc = GOOD.replace(from, to);
            assert_ne!(doc, GOOD, "replacement {from:?} must apply");
            assert_eq!(parse_state(&doc), None, "{doc} must be rejected");
        }
        assert_eq!(parse_state("not json"), None);
        assert_eq!(parse_state("[]"), None);
    }
}
