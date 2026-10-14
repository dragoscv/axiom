//! Fail-closed deny documents per harness (`--format`), mirroring the gate's deny contract in
//! packages/mcp/src/gate.ts. Used only when neither the daemon nor the axiom CLI can decide.

use crate::json::quote;

pub const CODE: &str = "ERR_INTERNAL";
pub const REASON: &str = "gate daemon unreachable and no axiom CLI found (fail-closed)";

/// What to print and how to exit.
#[derive(Debug, Clone, PartialEq)]
pub struct DenyOutput {
    pub stdout: Option<String>,
    pub stderr: String,
    pub exit: i32,
}

/// Gate flags the client itself needs (everything else is forwarded untouched).
#[derive(Debug, Clone, Default, PartialEq)]
pub struct GateFlags {
    pub format: String,
    pub deny_exit_2: bool,
    pub stdin: bool,
}

pub fn parse_flags(args: &[String]) -> GateFlags {
    let mut f = GateFlags {
        format: "auto".into(),
        ..GateFlags::default()
    };
    let mut i = 0;
    while i < args.len() {
        let a = args[i].as_str();
        let (name, inline) = match a.split_once('=') {
            Some((n, v)) if n.starts_with("--") => (n, Some(v.to_string())),
            _ => (a, None),
        };
        let mut value = || {
            inline.clone().or_else(|| {
                i += 1;
                args.get(i).cloned()
            })
        };
        match name {
            "--format" => {
                if let Some(v) = value() {
                    f.format = v.to_ascii_lowercase();
                }
            }
            "--deny-exit" => f.deny_exit_2 = value().as_deref() == Some("2"),
            "--stdin" => f.stdin = true,
            _ => {}
        }
        i += 1;
    }
    f
}

pub fn render(flags: &GateFlags, reason: &str) -> DenyOutput {
    let r = quote(reason);
    let hook = format!(
        "{{\"hookEventName\":\"PreToolUse\",\"permissionDecision\":\"deny\",\"permissionDecisionReason\":{r}}}"
    );
    let (stdout, exit) = match flags.format.as_str() {
        "codex" => (Some(format!("{{\"hookSpecificOutput\":{hook}}}")), 0),
        "cursor" => (
            Some(format!(
                "{{\"permission\":\"deny\",\"user_message\":{r},\"agent_message\":{r}}}"
            )),
            0,
        ),
        "windsurf" => (None, 2),
        "gemini" | "junie" => (Some(format!("{{\"decision\":\"deny\",\"reason\":{r}}}")), 0),
        "cline" => (Some(format!("{{\"cancel\":true,\"errorMessage\":{r}}}")), 0),
        // auto, claude, copilot, vscode and anything unknown: the combined document.
        _ => (
            Some(format!(
                "{{\"hookSpecificOutput\":{hook},\"permissionDecision\":\"deny\",\"permissionDecisionReason\":{r}}}"
            )),
            0,
        ),
    };
    DenyOutput {
        stdout,
        stderr: format!("AXIOM GATE DENY {CODE}: {reason}"),
        exit: if flags.deny_exit_2 { 2 } else { exit },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::json::{self, Json};

    fn flags(args: &[&str]) -> GateFlags {
        parse_flags(&args.iter().map(|s| s.to_string()).collect::<Vec<_>>())
    }

    #[test]
    fn parses_flags_in_both_spellings() {
        let f = flags(&[
            "--stdin",
            "--format",
            "Cursor",
            "--deny-exit=2",
            "--fail-open",
        ]);
        assert_eq!(f.format, "cursor");
        assert!(f.deny_exit_2 && f.stdin);
        let f = flags(&["--format=cline", "--deny-exit", "0"]);
        assert_eq!(f.format, "cline");
        assert!(!f.deny_exit_2 && !f.stdin);
        assert_eq!(flags(&[]).format, "auto");
        assert_eq!(flags(&["--format"]).format, "auto");
    }

    fn doc(out: &DenyOutput) -> Json {
        json::parse(out.stdout.as_deref().expect("stdout")).expect("valid JSON")
    }

    #[test]
    fn combined_document_for_claude_family() {
        for fmt in ["auto", "claude", "copilot", "vscode", "unknown"] {
            let out = render(&flags(&["--format", fmt]), REASON);
            assert_eq!(out.exit, 0);
            let d = doc(&out);
            assert_eq!(d.get("permissionDecision"), Some(&Json::Str("deny".into())));
            assert_eq!(
                d.get("permissionDecisionReason"),
                Some(&Json::Str(REASON.into()))
            );
            let h = d.get("hookSpecificOutput").expect("hookSpecificOutput");
            assert_eq!(
                h.get("hookEventName"),
                Some(&Json::Str("PreToolUse".into()))
            );
            assert_eq!(h.get("permissionDecision"), Some(&Json::Str("deny".into())));
        }
    }

    #[test]
    fn per_harness_documents() {
        let codex = doc(&render(&flags(&["--format", "codex"]), REASON));
        assert!(codex.get("permissionDecision").is_none());
        assert!(codex.get("hookSpecificOutput").is_some());

        let cursor = doc(&render(&flags(&["--format", "cursor"]), REASON));
        assert_eq!(cursor.get("permission"), Some(&Json::Str("deny".into())));
        assert_eq!(cursor.get("agent_message"), Some(&Json::Str(REASON.into())));

        for fmt in ["gemini", "junie"] {
            let d = doc(&render(&flags(&["--format", fmt]), REASON));
            assert_eq!(d.get("decision"), Some(&Json::Str("deny".into())));
            assert_eq!(d.get("reason"), Some(&Json::Str(REASON.into())));
        }

        let cline = doc(&render(&flags(&["--format", "cline"]), REASON));
        assert_eq!(cline.get("cancel"), Some(&Json::Bool(true)));
        assert_eq!(cline.get("errorMessage"), Some(&Json::Str(REASON.into())));

        let ws = render(&flags(&["--format", "windsurf"]), REASON);
        assert_eq!((ws.stdout, ws.exit), (None, 2));
    }

    #[test]
    fn deny_exit_2_forces_exit_2_and_stderr_line_is_exact() {
        let out = render(&flags(&["--deny-exit", "2", "--format", "cline"]), REASON);
        assert_eq!(out.exit, 2);
        assert!(out.stdout.is_some());
        assert_eq!(
            out.stderr,
            "AXIOM GATE DENY ERR_INTERNAL: gate daemon unreachable and no axiom CLI found (fail-closed)"
        );
    }

    #[test]
    fn reasons_are_json_escaped() {
        let out = render(&flags(&[]), "a \"quoted\" \\ path\n");
        let d = doc(&out);
        assert_eq!(
            d.get("permissionDecisionReason"),
            Some(&Json::Str("a \"quoted\" \\ path\n".into()))
        );
    }
}
