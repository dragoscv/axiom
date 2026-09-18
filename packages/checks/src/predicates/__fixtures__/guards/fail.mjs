process.stdout.write(
  JSON.stringify({
    ok: false,
    findings: [
      { id: "lint.todo", message: "TODO left in file", path: "src/a.ts" },
      { id: "lint.note", severity: "warn", message: "consider renaming", facts: { n: 1 } },
    ],
  }),
);
process.exit(1);
