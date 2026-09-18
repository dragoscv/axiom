let text = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => {
  text += d;
});
process.stdin.on("end", () => {
  let bundle;
  try {
    bundle = JSON.parse(text);
  } catch {
    process.stdout.write(
      JSON.stringify({ ok: false, findings: [{ id: "stdin", message: "not json" }] }),
    );
    return;
  }
  const ok =
    typeof bundle.manifestDigest === "string" &&
    bundle.manifestDigest.startsWith("sha256:") &&
    bundle.manifestDigest === process.env.AXIOM_MANIFEST_DIGEST &&
    typeof process.env.AXIOM_ROOT === "string";
  process.stdout.write(
    JSON.stringify({
      ok,
      findings: ok
        ? []
        : [
            {
              id: "stdin",
              message: `bad stdin/env: ${bundle.manifestDigest} vs ${process.env.AXIOM_MANIFEST_DIGEST}`,
            },
          ],
    }),
  );
});
