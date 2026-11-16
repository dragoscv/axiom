//! Fail-closed deny documents per harness (`--format`), mirroring the gate's deny contract in
//! packages/mcp/src/gate-format.ts. Used only when neither the daemon nor the axiom CLI can
//! decide.
//!
//! The per-harness table is NOT written here: it is generated into `deny_table.rs` from
//! `GATE_FORMAT_TABLE` by `scripts/gen-deny-table.mjs`, so the native client cannot drift from
//! the gate again (3.0 shipped a Rust copy without `kiro`, which reads exit 0 as an allow, and a
//! Claude document with top-level keys Claude rejects — A3-5/A2-19). A parity test runs both
//! renderers over `PARITY_GOLDEN`.

use crate::deny_table::{FORMAT_ROWS, AUTO_ROW};
use crate::json::quote;

pub const CODE: &str = "ERR_INTERNAL";
pub const REASON: &str = "gate daemon unreachable and no axiom CLI found (fail-closed)";
/// `AXIOM_GATE_DAEMON_STRICT=1` and the daemon answer failed its MAC.
pub const AUTH_CODE: &str = "ERR_DAEMON_AUTH";
pub const AUTH_REASON: &str = "gate daemon answer failed authentication (x-axiom-mac) — another process may be squatting the daemon port";

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
    render_code(flags, CODE, reason)
}

/// The generated row for `flags.format`; an unknown name falls back to `auto` (combined).
fn row(flags: &GateFlags) -> crate::deny_table::FormatRow {
    FORMAT_ROWS
        .iter()
        .find(|r| r.format == flags.format)
        .copied()
        .unwrap_or(AUTO_ROW)
}

pub fn render_code(flags: &GateFlags, code: &str, reason: &str) -> DenyOutput {
    let r = quote(reason);
    let hook = format!(
        "{{\"hookEventName\":\"PreToolUse\",\"permissionDecision\":\"deny\",\"permissionDecisionReason\":{r}}}"
    );
    let row = row(flags);
    let (stdout, exit) = match row.document {
        // Windsurf/Cascade and Kiro: the exit code IS the verdict, stdout is not read.
        "none" => (None, row.exit),
        "cursor" => (
            Some(format!(
                "{{\"permission\":\"deny\",\"user_message\":{r},\"agent_message\":{r}}}"
            )),
            row.exit,
        ),
        "decision" => (
            Some(format!("{{\"decision\":\"deny\",\"reason\":{r}}}")),
            row.exit,
        ),
        "cline" => (
            Some(format!("{{\"cancel\":true,\"errorMessage\":{r}}}")),
            row.exit,
        ),
        // Claude validates the hook document: ONLY `hookSpecificOutput`. Codex reads it too.
        "hook" => (Some(format!("{{\"hookSpecificOutput\":{hook}}}")), row.exit),
        // auto, copilot, vscode: the combined document, `axiom` block included (the gate's
        // `denyDocument`, so the two renderers stay byte-compatible apart from key order).
        _ => (
            Some(format!(
                "{{\"hookSpecificOutput\":{hook},\"permissionDecision\":\"deny\",\"permissionDecisionReason\":{r},\"axiom\":{{\"verdict\":\"deny\",\"code\":{},\"standard\":\"owasp-acs/0.1\"}}}}",
                quote(code)
            )),
            row.exit,
        ),
    };
    DenyOutput {
        stdout,
        stderr: format!("AXIOM GATE DENY {code}: {reason}"),
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

    /// The deny the TS renderer (`gate-format.ts`) produces for the same code/reason, embedded in
    /// the generated table. A3-5: the two renderers may not drift, for ANY `GATE_FORMATS` entry.
    #[test]
    fn every_format_matches_the_generated_parity_golden() {
        use crate::deny_table::{PARITY_CODE, PARITY_GOLDEN, PARITY_REASON};
        assert_eq!(PARITY_GOLDEN.len(), FORMAT_ROWS.len());
        for (format, want_stdout, want_exit) in PARITY_GOLDEN {
            let out = render_code(&flags(&["--format", format]), PARITY_CODE, PARITY_REASON);
            assert_eq!(out.exit, *want_exit, "{format}: exit code");
            match (out.stdout.as_deref(), want_stdout) {
                (None, None) => {}
                (Some(got), Some(want)) => {
                    assert_eq!(
                        json::parse(got),
                        json::parse(want),
                        "{format}: stdout document (key order ignored)"
                    );
                }
                (got, want) => panic!("{format}: stdout {got:?} != {want:?}"),
            }
        }
    }

    #[test]
    fn the_table_covers_every_format_once() {
        for (i, r) in FORMAT_ROWS.iter().enumerate() {
            assert!(
                !FORMAT_ROWS[..i].iter().any(|p| p.format == r.format),
                "duplicate row for {}",
                r.format
            );
        }
        assert_eq!(AUTO_ROW.format, "auto");
        assert_eq!(AUTO_ROW.document, "combined");
        // Kiro blocks on a non-zero exit only: exit 0 there is an ALLOW (A2-19).
        let kiro = FORMAT_ROWS.iter().find(|r| r.format == "kiro").expect("kiro");
        assert_eq!((kiro.document, kiro.exit), ("none", 2));
    }

    #[test]
    fn claude_gets_the_hook_document_alone_and_the_combined_family_the_rest() {
        // Claude validates the hook document against its schema: an extra top-level key turns the
        // deny into a non-blocking hook error (3.0 shipped the combined one here).
        let claude = render(&flags(&["--format", "claude"]), REASON);
        assert_eq!(claude.exit, 0);
        let d = doc(&claude);
        assert!(d.get("permissionDecision").is_none(), "no flat keys");
        assert!(d.get("axiom").is_none(), "no axiom block");
        let h = d.get("hookSpecificOutput").expect("hookSpecificOutput");
        assert_eq!(h.get("hookEventName"), Some(&Json::Str("PreToolUse".into())));
        assert_eq!(h.get("permissionDecision"), Some(&Json::Str("deny".into())));
        assert_eq!(h.get("permissionDecisionReason"), Some(&Json::Str(REASON.into())));

        for fmt in ["auto", "copilot", "vscode", "unknown"] {
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
            let axiom = d.get("axiom").expect("axiom block");
            assert_eq!(axiom.get("verdict"), Some(&Json::Str("deny".into())));
            assert_eq!(axiom.get("code"), Some(&Json::Str(CODE.into())));
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

        // Kiro blocks on any non-zero exit and does not read stdout: JSON + exit 0 was an allow.
        let kiro = render(&flags(&["--format", "kiro"]), REASON);
        assert_eq!((kiro.stdout, kiro.exit), (None, 2));
        // `--deny-exit 2` is the same exit, still with no document.
        let kiro2 = render(&flags(&["--format", "kiro", "--deny-exit", "2"]), REASON);
        assert_eq!((kiro2.stdout, kiro2.exit), (None, 2));
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
