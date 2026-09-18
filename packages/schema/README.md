# @codai/axiom-schema

Zod v4 schemas, closed error codes and generated JSON Schema for the AXIOM v2 data model
(`docs/design/v2-architecture.md` §2.2, §3.1, §4.2). Zero runtime deps besides `zod`.

| Module | Exports |
|---|---|
| `digest` | `Sha256HexSchema`, `DigestSchema`, `DigestRefSchema` (`sha256:<hex>`), `toDigestRef`, `digestRefHex` |
| `path` | `RelPathSchema`, `isValidRelPath`, `relPathIssues` — relative POSIX, NFC, ≤1024, no `..`/`\`/drive/reserved names/`<>:"|?*`/C0 |
| `errors` | `ERROR_CODES` tuple, `ErrorCode`, `AxiomError { code, path?, details? }`, `isAxiomError`, `isErrorCode` |
| `plan` | `PlanSchema`, `PlanArtifactSchema`, `PlanArtifactSourceSchema` (inline/cas/ref/template) |
| `check` | `CheckRefSchema`, `FindingSchema`, `CheckReportSchema` |
| `manifest` | `ManifestBodySchema` (JCS-hashed; artifacts/checks sorted+unique by UTF-8 byte order), `ManifestBundleSchema` (blobs ≤ 4 MiB), `compareUtf8` |
| `profile` | `ProfileSchema` |
| `apply` | `ApplyResultSchema`, `AppliedFileSchema`, `JournalSchema`, `ErrorCodeSchema` |

Naming: schemas end in `Schema`; inferred types are bare (`Plan`, `ManifestBundle`, …); `*Input`
types are the pre-default shape an agent sends. Callers assert on error **codes**, never message text.

`pnpm build:jsonschema` regenerates `schemas/*.schema.json` (draft 2020-12, input shape) — commit them.

**Why `isolatedDeclarations: false` here:** every export is a Zod schema whose type is a deeply
nested generic; spelling those annotations by hand is unmaintainable and adds no safety. This package
is the only one that overrides the base, and its `.d.ts` is still emitted by `tsdown`.
