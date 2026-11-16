// A1-10: a guard that prints a valid `{"ok":true}` and then crashes. The exit code, not the
// stdout, decides: a non-zero exit is ERR_GUARD_OUTPUT.
process.stdout.write(JSON.stringify({ ok: true, findings: [] }));
process.exit(3);
