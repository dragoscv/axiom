process.stdout.write("OK    a\nFAIL  b: reason here\n");
// Exit 0: a guard's exit code is part of the contract (A1-10) — the legacy text contract is
// `ok:false` plus FAIL lines, not a non-zero exit.
process.exit(0);
