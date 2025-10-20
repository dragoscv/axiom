# AXIOM Versioning & Compatibility

## Schema Version: 1.0.0

**Release Date:** October 20, 2025  
**Status:** Production Ready

### IR Schema Versioning

The AXIOM Intermediate Representation (IR) follows semantic versioning:

```typescript
{
  "ir": {
    "version": "1.0.0",  // MAJOR.MINOR.PATCH
    "agents": [...]
  }
}
```

**Version Policy:**
- **MAJOR** (1.x.x): Breaking changes to IR structure, capability model, or profile contracts
- **MINOR** (x.1.x): Backward-compatible additions (new emit types, capabilities, checks)
- **PATCH** (x.x.1): Bug fixes, documentation updates, non-functional changes

### 1.0.0 Guarantees

#### Deterministic Generation
- **buildId** = SHA256(normalized IR + profile)
- **createdAt** = `deterministic-${buildId.substring(0,16)}`
- **ALL artifacts** (including manifest.json) have identical hashes across identical inputs

#### Capability Sandbox
- **http.\*** effects require `net("http")` or `net("https")` capability
- **scan.artifacts.\*** effects require `fs("./path")` capability
- **ai.\*** effects require `ai("provider")` capability
- Violations are REJECTED during validation with clear diagnostics

#### Profile Enforcement
- **manifest.evidence[]** contains real measurements:
  - `max_dependencies` (Int64): Counted from package.json artifacts
  - `frontend_bundle_kb` (Int64): Sum of bytes from ./out/web/** artifacts
  - `no_analytics` (Boolean): Denylist scan for @vercel/analytics, analytics, ga-lite
  - `no_fs_heavy` (Boolean): Denylist scan for fs.readFileSync, fs.writeFileSync
  - `no_telemetry` (Boolean): Denylist scan for pino, winston, @opentelemetry

#### MCP Endpoints
- **POST /parse** - Parse .axm source to IR
- **POST /validate** - Validate IR against capability model
- **POST /generate** - Generate artifacts from IR + profile
- **POST /check** - Verify profile constraints with evidence
- **POST /reverse** - Reconstruct IR from ./out/** structure
- **POST /diff** - Generate JSON-Patch between two IRs
- **POST /apply** - Apply manifest to filesystem (mode: fs) or git PR (mode: pr)

### Migration Policy (Future)

When 2.0.0 is released, a codemod will be provided:

```bash
# Upgrade IR schema from 1.x to 2.x
npx @axiom/codemod migrate-ir --from=1.0.0 --to=2.0.0 ./examples/**/*.ir.json
```

**Deprecation Timeline:**
- 1.x support: **Minimum 12 months** after 2.0.0 release
- Security patches: **Minimum 24 months** after 2.0.0 release

### Compatibility Matrix

| AXIOM Core | IR Version | Node.js | TypeScript |
|------------|------------|---------|------------|
| 1.0.0      | 1.0.0      | >=18.0  | >=5.0      |

### Breaking Changes (from 0.x to 1.0.0)

1. **Deterministic Manifest**: `buildId` and `createdAt` are now hash-based (not time-based)
2. **Real Measurements**: Profile enforcement uses actual artifact scanning (not mock values)
3. **Capability Validation**: Strict enforcement of capability requirements (no bypass)
4. **MCP Response Structure**: All endpoints return `{result, diagnostics}` pattern

### Upgrade Guide (0.x → 1.0.0)

```diff
// Old (0.x): Time-based manifest
{
-  "buildId": "1729394556123",
-  "createdAt": "2025-10-20T01:42:36.123Z"
}

// New (1.0.0): Hash-based manifest
{
+  "buildId": "65b952edba8015c1ce61bda1b4935a35a7d40e90...",
+  "createdAt": "deterministic-65b952edba8015c1"
}
```

No code changes required - manifests are automatically migrated during generation.

### Security Model

**Threat Model:**
- **Capability Bypass**: MITIGATED - Validator enforces capability requirements before generation
- **Time-based Oracle Attacks**: MITIGATED - Deterministic buildId/createdAt eliminate timing side-channels
- **Artifact Tampering**: DETECTABLE - Golden snapshots + SHA256 hashes enable integrity verification
- **Profile Constraint Bypass**: MITIGATED - Real measurements from artifacts, not user-supplied values

### Provenance & SBOM

All 1.0.0 releases include:
- **SBOM** (Software Bill of Materials) in SPDX format
- **SLSA Level 3** provenance via GitHub Actions
- **Signed** manifest.json with detached signature
- **SHA256** hashes for all published artifacts

See `SECURITY.md` for vulnerability disclosure policy.
