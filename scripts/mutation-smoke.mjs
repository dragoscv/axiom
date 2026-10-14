#!/usr/bin/env node
/**
 * Mutation smoke (D-38, replaces Stryker S-110 while @stryker-mutator/vitest-runner is not
 * Vitest-5 aware). A fixed catalog of mutants on the security decisions of the write gate:
 * each mutant flips exactly one decision, the owning package's tests run, and the mutant must
 * be KILLED (tests fail). A survivor means that decision is untested — the run exits 1.
 *
 *   node scripts/mutation-smoke.mjs            # all mutants
 *   node scripts/mutation-smoke.mjs --list     # print the catalog
 *   node scripts/mutation-smoke.mjs --only=<id>[,<id>]
 *
 * Every mutated file is restored byte-for-byte in `finally` (and verified by sha256), so an
 * interrupted run leaves no mutant behind; a leftover `.mutation-smoke.bak` is restored first.
 * Packages are tested from source (vitest resolves workspace deps through each package's
 * vitest.config), so no build is needed between mutants. Uses execFile (no shell).
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** @type {{id:string,file:string,pkg:string,find:string,replace:string,why:string}[]} */
export const MUTANTS = [
  {
    id: "contain-escape",
    file: "packages/apply/src/contain.ts",
    pkg: "packages/apply",
    find: "if (!isContained(rootReal, parentReal)) {",
    replace: "if (false && !isContained(rootReal, parentReal)) {",
    why: "a path resolving outside the root must be refused (ERR_CONTAINMENT)",
  },
  {
    id: "contain-symlink",
    file: "packages/apply/src/contain.ts",
    pkg: "packages/apply",
    find: "if (st.isSymbolicLink()) {",
    replace: "if (false && st.isSymbolicLink()) {",
    why: "a symlink/junction segment must be refused (ERR_SYMLINK_IN_PATH)",
  },
  {
    id: "contain-create-exists",
    file: "packages/apply/src/contain.ts",
    pkg: "packages/apply",
    find: 'if (op === "create") {',
    replace: 'if (op === "create" && false) {',
    why: "op=create on an existing file must be refused (ERR_EXISTS)",
  },
  {
    id: "fsx-prefix-trap",
    file: "packages/apply/src/fsx.ts",
    pkg: "packages/apply",
    find: "return b === a || b.startsWith(a.endsWith(path.sep) ? a : a + path.sep);",
    replace: "return b === a || b.startsWith(a);",
    why: "/root-evil must not count as inside /root (separator-aware prefix)",
  },
  {
    id: "apply-toctou",
    file: "packages/apply/src/apply.ts",
    pkg: "packages/apply",
    find: "if (now !== f.preImage) {",
    replace: "if (false && now !== f.preImage) {",
    why: "a target changed between staging and commit must abort (ERR_PREIMAGE_CHANGED)",
  },
  {
    id: "apply-confirm-digest",
    file: "packages/apply/src/apply.ts",
    pkg: "packages/apply",
    find: 'if (mode !== "dry-run" && options.confirmDigest !== bundle.manifestDigest) {',
    replace:
      'if (false && mode !== "dry-run" && options.confirmDigest !== bundle.manifestDigest) {',
    why: "apply without the matching confirmDigest must be refused",
  },
  {
    id: "apply-digest-recompute",
    file: "packages/apply/src/apply.ts",
    pkg: "packages/apply",
    find: "if (recomputed !== bundle.manifestDigest) {",
    replace: "if (false && recomputed !== bundle.manifestDigest) {",
    why: "a bundle whose body does not hash to manifestDigest must be refused",
  },
  {
    id: "dsse-not-canonical",
    file: "packages/canon/src/dsse.ts",
    pkg: "packages/canon",
    find: 'if (canon !== text) return { ok: false, keyids: [], reason: "NOT_CANONICAL" };',
    replace: "",
    why: "a non-JCS payload must not verify (signature malleability)",
  },
  {
    id: "dsse-no-valid-sig",
    file: "packages/canon/src/dsse.ts",
    pkg: "packages/canon",
    find: "if (verified.size === 0) {",
    replace: "if (verified.size === 0 && false) {",
    why: "an envelope with no valid signature must not verify",
  },
  {
    id: "jcs-lone-surrogate",
    file: "packages/canon/src/jcs.ts",
    pkg: "packages/canon",
    find: 'if (c >= 0xdc00 && c <= 0xdfff) throw new CanonicalizeError("lone low surrogate");',
    replace: "",
    why: "a lone low surrogate must not canonicalize (RFC 8785 requires valid UTF-16)",
  },
  {
    id: "jcs-key-order",
    file: "packages/canon/src/jcs.ts",
    pkg: "packages/canon",
    find: "return a < b ? -1 : a > b ? 1 : 0;",
    replace: "return a < b ? 1 : a > b ? -1 : 0;",
    why: "object keys must sort in UTF-16 code-unit order (digest stability)",
  },
  {
    id: "preimage-drift",
    file: "packages/checks/src/facts/preimage.ts",
    pkg: "packages/checks",
    find: "if (actual !== e.sha256) out.push",
    replace: "if (false && actual !== e.sha256) out.push",
    why: "an on-disk change since compile must be reported as pre-image drift",
  },
  {
    id: "path-deny",
    file: "packages/checks/src/predicates/path.ts",
    pkg: "packages/checks",
    find: "return ctx.facts.manifest.paths.filter(denied).map((p) =>",
    replace: "return ctx.facts.manifest.paths.filter((x) => false && denied(x)).map((p) =>",
    why: "a denied path must produce a path.deny finding",
  },
  {
    id: "roots-inside",
    file: "packages/mcp/src/roots.ts",
    pkg: "packages/mcp",
    find: "return c.startsWith(p.endsWith(path.sep) ? p : p + path.sep);",
    replace: "return c.startsWith(p);",
    why: "--root containment must be separator-aware (/r/ab is not inside /r/a)",
  },
];

const sha = (b) => createHash("sha256").update(b).digest("hex");
const args = process.argv.slice(2);
const only = args
  .find((a) => a.startsWith("--only="))
  ?.slice(7)
  .split(",")
  .filter(Boolean);

if (args.includes("--list")) {
  for (const m of MUTANTS) console.log(`${m.id.padEnd(24)} ${m.file}  — ${m.why}`);
  process.exit(0);
}

const selected = only ? MUTANTS.filter((m) => only.includes(m.id)) : MUTANTS;
if (only && selected.length !== only.length) {
  console.error(
    `unknown mutant id in --only: ${only.filter((o) => !MUTANTS.some((m) => m.id === o)).join(",")}`,
  );
  process.exit(2);
}

// Recover from an interrupted earlier run before touching anything.
for (const f of new Set(MUTANTS.map((m) => m.file))) {
  const bak = join(ROOT, `${f}.mutation-smoke.bak`);
  if (existsSync(bak)) {
    renameSync(bak, join(ROOT, f));
    console.error(`restored ${f} from an interrupted run`);
  }
}

const vitest = join(ROOT, "node_modules", "vitest", "vitest.mjs");
function runTests(pkgDir) {
  const r = spawnSync(process.execPath, [vitest, "run", "--reporter=dot", "--bail=1"], {
    cwd: join(ROOT, pkgDir),
    encoding: "utf8",
    env: { ...process.env, CI: "true", FORCE_COLOR: "0" },
    maxBuffer: 64 * 1024 * 1024,
  });
  return r.status ?? 1;
}

// Baseline: every package involved must be green unmutated, or "killed" means nothing.
const pkgs = [...new Set(selected.map((m) => m.pkg))];
for (const p of pkgs) {
  if (runTests(p) !== 0) {
    console.error(`FAIL  mutation-smoke: baseline tests of ${p} are red — fix them first`);
    process.exit(1);
  }
}

const survivors = [];
let killed = 0;
for (const m of selected) {
  const abs = join(ROOT, m.file);
  const original = readFileSync(abs);
  const text = original.toString("utf8");
  const at = text.indexOf(m.find);
  if (at === -1 || text.indexOf(m.find, at + 1) !== -1) {
    console.error(
      `FAIL  mutation-smoke: anchor for ${m.id} is ${at === -1 ? "missing" : "not unique"} in ${m.file} — update the catalog`,
    );
    process.exit(1);
  }
  const bak = `${abs}.mutation-smoke.bak`;
  writeFileSync(bak, original);
  let code;
  try {
    writeFileSync(abs, text.slice(0, at) + m.replace + text.slice(at + m.find.length));
    code = runTests(m.pkg);
  } finally {
    writeFileSync(abs, original);
    rmSync(bak);
  }
  if (sha(readFileSync(abs)) !== sha(original)) {
    console.error(`FAIL  mutation-smoke: restore of ${m.file} failed - check the file by hand`);
    process.exit(1);
  }
  if (code === 0) {
    survivors.push(m);
    console.log(`SURVIVED ${m.id}  (${m.why})`);
  } else {
    killed++;
    console.log(`killed   ${m.id}`);
  }
}

if (survivors.length > 0) {
  console.error(
    `FAIL  mutation-smoke: ${survivors.length} of ${selected.length} mutants survived: ${survivors.map((m) => m.id).join(", ")}`,
  );
  process.exit(1);
}
console.log(`OK    mutation-smoke: ${killed} of ${selected.length} mutants killed`);
