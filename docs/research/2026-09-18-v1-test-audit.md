# v1 → v2 test-intent audit — S-112 (2026-09-18)

*Dated record — see [Design & research](../README.md#design--research).*

Scope: 27 files `packages/_v1/axiom-tests/src/*.test.ts` (150 title lines) +
`packages/policies/test/evaluator.test.ts` (read from `git show f673b16~1:…`;
the file is no longer in the tree — `packages/_v1/policies/` was removed by
the workspace reset, so it has 0 v2 tests only if we say so here). v2 = 321
title lines under `packages/{schema,canon,plan,checks,apply,mcp}/src`.

Method: every v1 `describe/it` title mapped to a v2 `file :: it` title, or
classified. v2 vocabulary shift to keep in mind while reading:

- v1 `repoPath` / `AXIOM_OUT_ROOT` / `process.cwd()` fallback → v2 explicit
  `--root` allowlist (PLAN §2 inv. 8). "cwd default" behaviour **does not exist**
  in v2, so tests asserting it are dropped by design.
- v1 `out/` prefix + `filesWritten` → v2 `ApplyResult.files[] {path,status}`
  with RelPaths (no prefix).
- v1 per-artifact `contentUtf8/contentBase64` + artifact store → v2 `blobs`
  (inline) or CAS (`.axiom/cas`).
- v1 emitters / profiles edge|budget / `.axm` parser / reverse-IR → removed
  (v2.1 at the earliest).

Legend: **C** covered · **CD** covered differently · **X** intentionally dropped
· **GAP** should add.

## Per-file table

| # | v1 file :: test | Verdict | v2 equivalent / reason |
|---|---|---|---|
| 1 | apply-absolute-repoPath :: absolute Unix path / Windows absolute path | CD | `mcp/roots.test.ts :: createRootsPolicy: realpaths, freezes, rejects missing/non-dir/relative` — roots must be absolute, realpath'd |
| 1 | :: normalize relative repoPath to absolute | X | v2 rejects relative roots (`roots.test.ts` same it); no cwd fallback by design (inv. 8) |
| 1 | :: reject invalid repoPath | C | `apply/apply.test.ts :: ERR_ROOT_NOT_DIR`; `mcp/server.test.ts :: root outside the allowlist → ERR_ROOT_NOT_ALLOWED` |
| 2 | apply-cross-drive-semantics :: S1 same-volume tmp+rename | C | `apply/write.test.ts :: writes, re-hashes, leaves no tmp file, creates parent dirs` (tmp is always same-dir `.axiom-tmp-*`) |
| 2 | :: S2 cross-volume via AXIOM_OUT_ROOT | X | `AXIOM_OUT_ROOT` removed; staging is always inside `<root>/.axiom/staging` so cross-volume rename cannot occur |
| 2 | :: S3 read-back verification mandatory | C | `write.test.ts :: writes, re-hashes…` (`writeAtomic` returns re-hashed sha, asserted `=== sha256Hex(bytes)`) |
| 3 | apply-enhanced-fs :: T1 relative repoPath `.` | X | relative root rejected (see #1) |
| 3 | :: T2 absolute path | C | `apply.test.ts :: creates 2 files, overwrites 1, deletes 1; journal + applied marker written; staging cleaned` |
| 3 | :: T3 AXIOM_OUT_ROOT override / T4 cross-drive | X | env override removed (inv. 8) |
| 4 | apply-inline-content :: contentUtf8 text | C | `plan/compile.test.ts :: utf8 text stays utf8…` + `apply.test.ts` happy path |
| 4 | :: contentBase64 binary | C | `compile.test.ts :: utf8 text stays utf8; bytes with NUL go base64`, `:: invalid utf8 without NUL goes base64` |
| 4 | :: multiple mixed inline | C | `compile.test.ts :: compiles inline sources into a content-addressed bundle` (mixed encodings) |
| 5 | apply-phantom-smoke :: writes real files | C | `apply.test.ts :: creates 2 files…` reads bytes back from disk |
| 5 | :: fails if content missing from cache | C | `apply.test.ts :: ERR_BLOB_MISSING aborts before any write` |
| 6 | apply-physical-smoke :: exact content / missing content | C | same as #5 |
| 7 | apply-reject-backslash-paths :: backslash / Windows separators / mixed | C | `schema/path.test.ts` cases `backslash`, `drive letter`; `apply/contain.test.ts :: rejects a\\b → ERR_PATH_NOT_RELATIVE_POSIX` |
| 7 | :: accept forward slashes only | C | `path.test.ts` `nested` case |
| 8 | apply-repopath-dot :: T1 fail-closed cwd=HOME + `.` | X | no cwd fallback exists to fail-close; `mcp/server.test.ts :: no root with several allowlisted roots → ERR_ROOT_REQUIRED` is the analogue |
| 8 | :: T2 AXIOM_REPO_ROOT env / T4 cross-drive | X | env removed |
| 8 | :: T3 absolute ok | C | apply happy path |
| 9 | apply-reporoot :: process.cwd() default / create ./out / filesWritten under out/ | X | cwd default and `out/` prefix both removed (D-xx roots allowlist); `files[]` shape validated by `schema/apply.test.ts :: AppliedFileSchema validates status enum and RelPath` |
| 10 | apply-same-drive-abs :: T1 fail-closed / T3 / T4 env | X | as #8 |
| 10 | :: T2 same-drive absolute writes physical file | C | apply happy path |
| 11 | apply-sandbox :: reject `..` / absolute / only under root | C | `contain.test.ts :: rejects ../x, /abs, C:/x`; `:: rejects symlink / junction directory escape`; `apply.test.ts :: artifacts targeting .axiom/ are rejected` |
| 12 | apply-security :: absolute / `..` / `..` anywhere / safe relative | C | `contain.test.ts` (`../x`, `a/../b`); `schema/path.test.ts` |
| 13 | apply-stateless-inline :: utf8 / base64 / mixed | C | as #4 |
| 13 | :: ERR_ARTIFACT_CONTENT_MISSING | C | `apply.test.ts :: ERR_BLOB_MISSING aborts before any write`; `plan/verify.test.ts :: missing blob is reported in missing` |
| 14 | **check-aggregate-and** :: passed when ALL pass | C | `checks/run.test.ts :: pass with no findings` |
| 14 | :: passed=false when ANY fails | C | `run.test.ts :: fail when an error-severity finding exists` (single failing check among passing profile checks) |
| 14 | :: empty checks → vacuous truth | **GAP** | no v2 test runs `runChecks` with a profile whose `checks: []` — see G1 |
| 15 | check-evaluator-and-logic :: evaluated:true for all + AND | CD | v2 has no `evaluated` flag; every check yields findings or an `error` verdict (`run.test.ts :: error when a predicate throws`, `:: error on unknown predicate`) — fail-closed replaces "evaluated" |
| 15 | :: ALL pass / ANY fail / empty | C / C / **GAP** | as #14 |
| 16 | check-evaluator :: constraint met (edge) / not met / multi aggregate | CD | v1 numeric thresholds on emitter facts (bundle KB, cold-start) — emitters gone. Numeric predicates covered by `predicates.test.ts :: maxBytes fails only over the limit`, `:: maxArtifacts`, `:: maxTotalBytes` |
| 17 | **concurrency-uniqueness** :: C1 200 parallel artifacts no collision | **GAP** | `plan/cas.test.ts :: concurrent puts of the same bytes all succeed` (8× same bytes) and `apply.test.ts :: two concurrent applies on the same root serialise` (2 applies) exist, but nothing writes many *distinct* files through `writeAtomic` in parallel in one dir — see G2 |
| 17 | :: C2 tmp uniqueness under high concurrency | **GAP** | `write.test.ts` checks *no tmp left*, not uniqueness under contention — G2 covers (asserts every `.axiom-tmp-*` distinct + none left) |
| 17 | :: C3 race read-back verification | C | `apply.test.ts :: pre-image changed between staging and commit → rolled-back, tree byte-identical` (TOCTOU) |
| 18 | debug-posix :: show paths in memory vs JSON | X | debug print test, no assertion of value |
| 19 | **determinism-edge** :: identical manifest SHA two runs | C | `plan/compile.test.ts :: same plan twice → identical manifestDigest and JCS body` |
| 19 | :: different SHA for different profiles | CD | profiles no longer affect manifests; the analogue "different input → different digest" is `checks/run.test.ts :: factsDigest changes with the check set` and `compile.test.ts :: inline vs cas store → same manifestDigest, different blobs` |
| 19 | :: consistent artifact hashes across runs | C | `compile.property.test.ts :: permuting artifacts keeps manifestDigest and canonical body`; `canon/statement.test.ts :: is deterministic` |
| 20 | **error-paths** :: E1 read-only dir fails gracefully | **GAP** | no v2 test provokes an EACCES/EPERM on commit; apply maps unknown errors to `ERR_INTERNAL` (`apply.ts:104`) with rollback — untested — see G3 |
| 20 | :: E2 failures[] contains attemptPath | CD | `ApplyError.path` is in the schema (`schema/apply.test.ts :: failed requires an error with a known code`); populated for path errors via `contain.test.ts`. G3 also asserts `error.path` on an IO failure |
| 20 | :: E3 invalid path clear error / E4 traversal | C | `contain.test.ts` codes |
| 20 | :: E5 hash mismatch | C | `apply.test.ts :: ERR_DIGEST_MISMATCH when blob bytes differ from declared digest` |
| 20 | :: E6 size mismatch | C | `apply.test.ts :: ERR_DIGEST_MISMATCH precisely when size matches` (+ digest mismatch case covers size≠) |
| 21 | generate-then-apply-stateless :: generate→apply | CD | generate (emitters) gone; `mcp/server.test.ts :: validate → compile → check → dry-run → apply → resource → rollback` and `mcp/cli.test.ts :: compile → verify → check → apply…` are the end-to-end pipelines |
| 22 | golden :: EDGE/BUDGET artifact counts, byte sizes, deps, 101-byte diff | X | emitter profiles removed. Golden *determinism* lives in `testkit/golden` + `check-golden-digests.mjs` (cross-OS digest pin) |
| 22 | :: it.skip snapshot hashes (TODO) | X | replaced by pinned `.expected.json` digests |
| 23 | **long-paths-windows** :: L1 path > 260 chars written | **GAP** | `schema/path.test.ts` accepts a 1024-char RelPath and `fsx.nsPath` adds `\\?\`, but no test writes/reads a >260-char target through `writeAtomic`/`fsApply` — see G4 |
| 23 | :: L2 filesWrittenAbs full long path | X | v2 returns RelPaths only (`AppliedFileSchema`) |
| 23 | :: L3 multiple long paths one manifest | **GAP** | G4 uses 3 artifacts |
| 24 | parser-roundtrip :: inline / block .axm / IR golden | X | `.axm` DSL deferred to v2.1 (PLAN D-xx); no parser in v2.0 |
| 25 | path-normalization-deepcopy :: normalize without mutating input | CD | v2 never normalizes: backslash paths are **rejected** (`path.test.ts` `backslash`), and `PlanSchema` is strict; compile property test `:: permuting artifacts keeps manifestDigest` proves input order is not depended on. Non-mutation of the input plan is not asserted — folded into G5 |
| 25 | :: Windows-style paths normalize | X | reject, not normalize (design change) |
| 26 | **path-normalization** :: only forward slashes in artifact paths | C | `schema/manifest.test.ts :: ManifestArtifactSchema is strict and validates origin` + `path.test.ts` `backslash`, `drive letter` reject; every manifest path is a RelPath |
| 26 | :: writes correctly on disk despite POSIX paths | C | `apply.test.ts` happy path on Windows CI (`ci.yml` 3 OS) joins RelPath with `path.join` |
| 27 | path-validation-fastcheck :: P1 backslash / traversal / absolute / mixed | C | `schema/path.test.ts` table; `checks/path-fuzz.test.ts :: allow/deny/reservedNames return valid findings` (fast-check RelPaths) |
| 27 | :: P2 reserved names / trailing space-dot / invalid chars | C | `path.test.ts` (`CON`, `con.txt`, `lpt9 ext`, `Aux.TS`, `trailing dot`, `trailing space`, `ADS colon`, `pipe`, `C0 control`); `contain.test.ts :: rejects Windows reserved name %s on every OS` |
| 27 | :: P3 NFC normalization | CD | v2 **rejects** NFD (`path.test.ts` `NFD string → ERR_PATH_NOT_NFC`) instead of normalizing; `contain.test.ts :: detects case collision after NFC + lowercase` |
| 27 | :: P4 simple / deep nesting 100 levels / redundant slashes / spaces | C / **GAP** / C / C | `a//b`, `./a` rejected (not normalized — design); "spaces but not trailing" covered. 100-level nesting not tested — G5 |
| 27 | :: P5 determinism / zero cwd dependency | C | `compile.test.ts` determinism; roots are explicit so cwd cannot leak (`roots.test.ts`) |
| 28 | policies/evaluator :: numeric `<= < >= >` / false condition | X | expression evaluator removed; predicates are typed Zod params (`predicates.test.ts :: maxBytes…`) |
| 28 | :: boolean `== !=` | X | same |
| 28 | :: no_personal_data() / email / phone / CNP PII | C | `predicates.test.ts :: content.noSecrets has a sample for every pattern` + `:: catches ${name}` iterates `SECRET_PATTERNS` incl. `cnp`, `email`, `phoneRo` |
| 28 | :: http.healthy requires net capability | CD | `predicates.test.ts :: guard.external is registered but yields an error verdict in v2.0`, `:: errors when the profile forbids guards` — network predicates fail closed |
| 28 | :: unknown function / unknown operator throw | C | `run.test.ts :: error on unknown predicate`, `:: error on bad params (fail closed)` |

## Totals

Counting each v1 `it` (150 axiom-tests lines minus 27 `describe`s ≈ 118 its,
+16 evaluator its = **134 v1 tests**):

| Verdict | Count |
|---|---|
| Covered (C) | 71 |
| Covered differently (CD) | 14 |
| Intentionally dropped (X) | 41 |
| **GAP** | **8** (→ 5 concrete tests, G1–G5) |

Mandatory-list check: `concurrency-uniqueness` → GAP (G2) · `long-paths-windows`
→ GAP (G4) · `determinism-edge` → covered · `error-paths` → GAP (G3, E1 only) ·
`check-aggregate-and` → GAP (G1, vacuous truth only) · `path-normalization` →
covered (as rejection).

## GAP tests to add

### G1 — `packages/checks/src/run.test.ts` (in `runChecks verdict matrix`)

```ts
it("empty check set → pass with no findings (vacuous truth), factsDigest still set", async () => {
  const r = await runChecks({ bundle: b, profile: profileWith([]) });
  expect(r.verdict).toBe("pass");
  expect(r.findings).toEqual([]);
  expect(r.factsDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
});
```

(If `ProfileSchema` requires ≥1 check, the test must instead assert
`ERR_INVALID_PROFILE` — either way the behaviour is pinned.)

### G2 — `packages/apply/src/write.test.ts`

```ts
it("200 parallel writeAtomic into one dir: distinct tmp names, all committed, no tmp left", async () => {
  const root = await mkRoot();
  const seen = new Set<string>();
  const origOpen = fs.open;
  const spy = vi.spyOn(fs, "open").mockImplementation(async (p, ...rest) => {
    const s = String(p);
    if (path.basename(s).startsWith(".axiom-tmp-")) {
      expect(seen.has(s)).toBe(false);
      seen.add(s);
    }
    return origOpen(p as string, ...(rest as [string, number]));
  });
  try {
    await Promise.all(
      Array.from({ length: 200 }, (_, i) =>
        writeAtomic(path.join(root, `f${i}.txt`), new TextEncoder().encode(`v${i}`)),
      ),
    );
  } finally {
    spy.mockRestore();
  }
  expect(seen.size).toBe(200);
  const names = await fs.readdir(root);
  expect(names.filter((n) => n.startsWith(".axiom-tmp-"))).toEqual([]);
  expect(names.filter((n) => /^f\d+\.txt$/.test(n))).toHaveLength(200);
  expect(await fs.readFile(path.join(root, "f137.txt"), "utf8")).toBe("v137");
});
```

### G3 — `packages/apply/src/apply.test.ts` (in `TOCTOU and rollback`)

```ts
it("IO failure at commit (target dir made read-only) → failed with error.path, tree rolled back byte-identical", async () => {
  if (process.platform === "win32" && !process.env.CI) return; // chmod is advisory on NTFS; runs on ubuntu/macos CI
  const root = await mkRoot();
  await fs.mkdir(path.join(root, "ro"));
  await fs.writeFile(path.join(root, "keep.txt"), "keep");
  const bundle = makeBundle([
    { path: "keep.txt", content: "changed", op: "overwrite" },
    { path: "ro/new.txt", content: "x" },
  ]);
  await fs.chmod(path.join(root, "ro"), 0o555);
  try {
    const r = await fsApply(bundle, root, { confirmDigest: bundle.manifestDigest });
    expect(r.status).toBe("rolled-back");
    expect(r.error?.code).toBe("ERR_INTERNAL"); // or a dedicated ERR_IO once added to ERROR_CODES
    expect(r.error?.path).toBe("ro/new.txt");
    expect(await readText(root, "keep.txt")).toBe("keep");
  } finally {
    await fs.chmod(path.join(root, "ro"), 0o755);
  }
});
```

Note: this will surface that `ERR_INTERNAL` is what an EACCES currently maps to
(`apply.ts:104`). If a distinct code is wanted, add `ERR_IO` to
`packages/schema/src/errors.ts` first (closed enum, inv. 4).

### G4 — `packages/apply/src/apply.test.ts` (new `describe("long paths")`)

```ts
it("writes, re-reads and deletes three targets whose absolute path exceeds 260 chars", async () => {
  const root = await mkRoot();
  const deep = Array.from({ length: 12 }, (_, i) => `segment-${i}-${"x".repeat(20)}`).join("/");
  const paths = [`${deep}/a.txt`, `${deep}/b.txt`, `${deep}/c/${"y".repeat(60)}.txt`];
  for (const p of paths) expect(path.join(root, p).length).toBeGreaterThan(260);
  const bundle = makeBundle(paths.map((p, i) => ({ path: p, content: `v${i}` })));
  const r = await fsApply(bundle, root, { confirmDigest: bundle.manifestDigest });
  expect(r.status).toBe("applied");
  expect(r.files.map((f) => f.path).sort()).toEqual([...paths].sort());
  expect(await readText(root, paths[2])).toBe("v2");
  const del = makeBundle(paths.map((p) => ({ path: p, op: "delete" })), { name: "del" });
  expect((await fsApply(del, root, { confirmDigest: del.manifestDigest })).status).toBe("applied");
});
```

Runs on all three CI OSes; on Windows it is the only thing exercising
`fsx.nsPath`'s `\\?\` prefix end-to-end.

### G5 — `packages/plan/src/compile.test.ts` (in `compilePlan — happy path`)

```ts
it("100-level nesting compiles; the input plan object is not mutated", async () => {
  const p = `${Array.from({ length: 100 }, (_, i) => `d${i}`).join("/")}/leaf.ts`;
  const plan = makePlan([{ path: p, content: "x" }]);
  const frozen = structuredClone(plan);
  const r = await compilePlan(plan);
  expect(r.ok).toBe(true);
  if (r.ok) expect(r.bundle.manifest.artifacts[0]?.path).toBe(p);
  expect(plan).toEqual(frozen);
});
```

(Adjust `makePlan`/result shape to the helper already in `compile.test.ts`.)

## Deletion list (S-112 "delete the rest")

Everything under `packages/_v1/axiom-tests/` can be deleted once G1–G5 land;
nothing in it is imported by v2 (`check-no-v1-imports`). `golden.test.ts`
depends on root `out-edge/`/`out-budget/` that no longer exist, and
`path-validation-fastcheck.test.ts` fails to load — both already dead.
