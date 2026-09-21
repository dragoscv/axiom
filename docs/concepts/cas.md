# The CAS — `<root>/.axiom/cas`

*The per-root content-addressed store that keeps bytes out of the canonical manifest, and the `axiom gc` that reclaims it.*

Content-addressed store of artifact bytes, one per repository root. It is the transport that
keeps content **out of the canonical manifest** ([invariant 2](invariants.md)): the manifest holds
`{ path, digest, bytes, origin }`, the CAS holds the bytes.

## Layout

```
<root>/.axiom/
  cas/sha256/<aa>/<hex>          blob; <aa> = first two hex chars, <hex> = full sha256
  cas/sha256/<aa>/<hex>.<pid>.<rand>.tmp   in-flight write (removed by gc when stale)
  manifests/<hex>.json           every ManifestBundle compiled/applied on this root
  applied/<hex>.json             ApplyResult of an applied manifest
  journal/<hex>.json             two-phase-commit journal (present only mid-apply or after a crash)
  lock                           single-writer lock (JSON holder: pid, hostname, startedAt)
```

Writers (`packages/plan/src/cas.ts` `casPut`, `packages/plan/src/ref.ts` `resolveRef`) always
write `tmp → fsync → rename`; a concurrent writer of the same content is harmless because the
target is identical by definition. Readers (`casGet` in plan, `resolveContent` in apply) re-hash
the bytes before use, so a corrupted blob is `ERR_DIGEST_MISMATCH`, never silently applied.

What lands here:

| Source | When |
|--------|------|
| `inline` / `template` | `compile --store cas` (blobs leave the bundle, digest stays) |
| `cas` | never written — must already be present (`ERR_BLOB_MISSING` otherwise) |
| `ref` | `compile --allow-net` after the pinned digest verified; see [plan-format.md](../reference/plan-format.md#ref-sources) |

## Garbage collection — `axiom gc`

Blobs are never removed implicitly. `axiom gc --root <dir> [--dry-run] [--older-than <n>(ms|s|m|h|d)]
[--keep all-manifests|journal]` (`packages/mcp/src/gc.ts` `collectGarbage`) removes blobs no live
manifest references:

- **Live set** — `--keep all-manifests` (default): every artifact digest of every
  `manifests/*.json`. `--keep journal`: only manifests named by a `journal/` entry (an apply in
  flight or crashed) or an `applied/` record — compiled-but-never-applied manifests stop pinning
  their blobs. Journals always pin, whatever `--keep` says.
- **Candidates** — every regular file under `cas/sha256/*/` whose name is 64 hex chars and is not
  in the live set, plus orphaned `*.tmp` files from a crashed writer.
- **`--older-than`** — only candidates whose mtime is older than the duration are removed; younger
  ones are reported as `skippedYoung`. Use it on a root where another process may be compiling.
- **Result** — `{ root, keep, dryRun, scanned, live, missing, removed: [{sha, bytes}], skippedYoung,
  freedBytes }`. `missing` counts live digests that have no blob (an apply of that manifest would
  need `compile --allow-net` or `--store cas` first). `--dry-run` produces the same report and
  deletes nothing.

### Safety

- GC takes `.axiom/lock` exactly like `apply` does (waits 1 s, reclaims a stale lock whose pid is
  dead or older than 60 min). A **live holder → `ERR_LOCKED`** with the holder in `details`; GC
  never runs beside an apply, and an apply cannot start while GC runs.
- A stored manifest that is unreadable or fails `ManifestBundleSchema` aborts the run
  (`ERR_INVALID_MANIFEST`), and a journal naming a manifest that is not stored aborts with
  `ERR_BLOB_MISSING` — fail closed rather than compute a partial live set and delete too much.
- Deletion is `rm` of unreferenced blobs only; `manifests/`, `applied/`, `journal/`, `backup/`,
  `trust/` are never touched. Rollback does not depend on the CAS (it uses `backup/`).
- Idempotent: a second run right after the first removes 0.
- **CLI only.** GC is destructive and has no MCP tool on purpose: an agent may compile and apply
  through the server, but reclaiming disk on a root is an operator action. The MCP surface
  ([mcp-tools.md](../reference/mcp-tools.md)) intentionally lists no `axiom_gc`.

---

**See also**

- [Pipeline](pipeline.md) — the three content transports (blobs, CAS, ref) side by side
- [Invariants](invariants.md) — invariant 2, which the CAS exists to satisfy
- [Plan format](../reference/plan-format.md#ref-sources) — `ref` sources and the network policy
- [CLI](../reference/cli.md#gc) — `axiom gc` flags
