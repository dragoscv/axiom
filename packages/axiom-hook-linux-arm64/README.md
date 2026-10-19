# @codai/axiom-hook-linux-arm64

The native `axiom-hook` gate client (crates/axiom-hook, Rust, std only) prebuilt for
**linux-arm64**. You do not install this package directly: `@codai/axiom-mcp` lists it in
`optionalDependencies`, and npm/pnpm install only the one whose `os`/`cpu` match the machine.

The binary is `bin/axiom-hook`. It is produced by `.github/workflows/release.yml` on a
native runner (the same bytes as the `axiom-hook-linux-arm64` GitHub release asset, listed in
that release's `SHA256SUMS` and Sigstore provenance) and published with npm provenance. The
repository copy of this directory has no `bin/`: it exists only in the published tarball.

## Locating the binary

```js
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);
function axiomHookPath() {
  const name = `@codai/axiom-hook-${process.platform}-${process.arch}`;
  try {
    const dir = dirname(require.resolve(`${name}/package.json`));
    return join(dir, "bin", process.platform === "win32" ? "axiom-hook.exe" : "axiom-hook");
  } catch {
    return null; // no prebuilt for this platform, or optional deps were omitted: use `axiom gate`
  }
}
```

`axiom init` / `axiom doctor` use this to wire the native client; when it returns `null` they
fall back to the Node gate (`axiom gate --stdin`).

License: MIT. Source and issues: <https://github.com/dragoscv/axiom>.
