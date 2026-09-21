/**
 * Package version, resolved once.
 *
 * Normal builds read `../package.json` next to `dist/` at runtime. The single-executable
 * build (D-27) has no `package.json` on disk and `import.meta.url` points at the binary, so
 * tsdown `define`s `__AXIOM_VERSION__` to the package version at build time and this module
 * never touches the filesystem there.
 */
import { createRequire } from "node:module";

declare const __AXIOM_VERSION__: string | undefined;

function readVersion(): string {
  if (typeof __AXIOM_VERSION__ === "string") return __AXIOM_VERSION__;
  const require = createRequire(import.meta.url);
  return (require("../package.json") as { version: string }).version;
}

export const PACKAGE_VERSION: string = readVersion();
