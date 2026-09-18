const leaked = process.env.SECRET_X !== undefined;
const passed = process.env.GUARD_EXTRA === "yes";
process.stdout.write(
  JSON.stringify({
    ok: !leaked && passed,
    findings: leaked
      ? [{ id: "env", message: "SECRET_X leaked" }]
      : passed
        ? []
        : [{ id: "env", message: "GUARD_EXTRA missing" }],
  }),
);
