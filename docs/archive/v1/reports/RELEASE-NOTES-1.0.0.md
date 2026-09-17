# AXIOM 1.0.0 Release Notes

**Release Date:** October 20, 2025  
**Status:** ✅ Production Ready

---

## 🎯 What's New

### Deterministic Manifest Generation
- **buildId** = SHA256(normalized IR + profile) - no more timestamp-based builds
- **createdAt** = `deterministic-{hash}` - eliminates timing side-channels
- **100% reproducible** - identical inputs produce identical artifacts AND manifest.json

**Before (0.x):**
```json
{
  "buildId": "1729394556123",
  "createdAt": "2025-10-20T01:42:36.123Z"
}
```

**After (1.0.0):**
```json
{
  "buildId": "65b952edba8015c1ce61bda1b4935a35a7d40e90...",
  "createdAt": "deterministic-65b952edba8015c1"
}
```

### New MCP Endpoints

#### `/reverse` - Reconstruct IR from Artifacts
Scans `./out/**` directory structure and reconstructs an IR:
```bash
curl -X POST http://localhost:3411/reverse \
  -H 'Content-Type: application/json' \
  -d '{"repoPath":"."}'
```

**Detects:**
- `web-app` (next.config.*, package.json with react/next)
- `api-service` (express/fastify patterns)
- `docker-image` (Dockerfile, docker-compose.yml)
- `tests`, `manifest`, `docs` targets

#### `/diff` - Generate JSON-Patch Between IRs
```bash
curl -X POST http://localhost:3411/diff \
  -H 'Content-Type: application/json' \
  -d '{"oldIr":{...}, "newIr":{...}}'
```

**Returns:** RFC 6902 JSON-Patch operations

#### `/apply` - Apply Manifest to Filesystem or PR
```bash
# Write to filesystem
curl -X POST http://localhost:3411/apply \
  -H 'Content-Type: application/json' \
  -d '{"manifest":{...}, "mode":"fs"}'

# Create git PR
curl -X POST http://localhost:3411/apply \
  -H 'Content-Type: application/json' \
  -d '{"manifest":{...}, "mode":"pr", "remote":"origin"}'
```

### Real Profile Enforcement

**manifest.evidence[]** now contains **actual measurements** from artifacts:

```json
{
  "evidence": [{
    "checkKind": "policy",
    "checkName": "no-pii",
    "passed": true,
    "details": {
      "measurements": {
        "max_dependencies": 3,          // Counted from package.json
        "frontend_bundle_kb": 24,       // Sum of bytes from ./out/web/**
        "no_analytics": true,           // Denylist scan: @vercel/analytics
        "no_fs_heavy": true,            // Denylist scan: fs.readFileSync
        "no_telemetry": true            // Denylist scan: pino, winston
      }
    }
  }]
}
```

**Types:** Int64 for counts/sizes, Boolean for flags - no more mock values or strings.

### Strict Capability Sandbox

**All effects require explicit capabilities:**

```axiom
agent "secure-api" {
  capabilities {
    net("http")   // Required for http.* effects
    fs("./out")   // Required for scan.artifacts.* effects
  }
  
  checks {
    unit "health" expect http.healthy("http://localhost:4000/health")
    policy "no-pii" expect scan.artifacts.no_personal_data()
  }
}
```

**Without capabilities:** Validation returns `ok: false` with clear diagnostic:
```json
{
  "ok": false,
  "diagnostics": [{
    "message": "Check 'health' uses http.* but capability net(...) is missing"
  }]
}
```

---

## 🔧 Breaking Changes

### 1. Manifest Structure
- `buildId` is now SHA256 hash (64 chars) instead of timestamp number
- `createdAt` is `deterministic-{hash}` instead of ISO 8601 timestamp

**Migration:** No code changes needed - automatically migrated during generation

### 2. Profile Evidence
- `evidence[].details.measurements` must contain real numeric values
- Custom profiles must implement `calculateRealMetrics()` or use defaults

**Migration:** Update profile implementations to scan artifacts, not hardcode values

### 3. Capability Validation
- Strict enforcement - no capability bypass possible
- `http.*`, `scan.artifacts.*`, `ai.*` effects require explicit capability grants

**Migration:** Add missing capabilities to agent definitions

---

## 📦 Installation

```bash
# NPM
npm install @axiom/core@1.0.0 @axiom/engine@1.0.0 @axiom/mcp@1.0.0

# PNPM
pnpm add @axiom/core@1.0.0 @axiom/engine@1.0.0 @axiom/mcp@1.0.0

# Yarn
yarn add @axiom/core@1.0.0 @axiom/engine@1.0.0 @axiom/mcp@1.0.0
```

---

## 🧪 Testing & Validation

**All production-ready tests passed:**
- ✅ Determinism (EDGE & BUDGET manifest SHA256 identical across runs)
- ✅ MCP Endpoints (/reverse, /diff, /apply functional)
- ✅ Profile Enforcement (Real numeric measurements in evidence)
- ✅ Capability Sandbox (Negative tests correctly reject violations)
- ✅ CI & Snapshots (Golden snapshots detect artifact corruption)

**Smoke Test:**
```bash
bash scripts/smoke.sh
```

---

## 📄 Documentation

- **[Versioning Policy](docs/versioning.md)** - Schema versioning, compatibility matrix
- **[Security Policy](SECURITY.md)** - Threat model, vulnerability reporting
- **[Support Policy](SUPPORT.md)** - LTS timeline, backport policy
- **[GO/NO-GO Report](GO-NOGO-REPORT.md)** - Complete validation evidence

---

## 📥 Release Artifacts

**Download from GitHub Release:**
- `axiom-1.0.0-bundle.tar.gz` - Complete release bundle with evidence
- `axiom-1.0.0-bundle.tar.gz.sha256` - SHA256 hash verification
- `sbom.json` - Software Bill of Materials (CycloneDX format)
- `test-results/*.json` - Validation test outputs

**NPM Packages (with provenance):**
- `@axiom/core@1.0.0`
- `@axiom/engine@1.0.0`
- `@axiom/mcp@1.0.0`
- `@axiom/policies@1.0.0`
- `@axiom/emitter-webapp@1.0.0`
- `@axiom/emitter-apiservice@1.0.0`
- `@axiom/emitter-docker@1.0.0`
- `@axiom/emitter-batchjob@1.0.0`

---

## 🛣️ Roadmap

### 1.1.0 (January 2026)
- Signed emitters with hash pinning
- `profile.lock` for reproducible builds
- LSP for `.axm` syntax highlighting and diagnostics

### 1.2.0 (April 2026)
- Runtime capability enforcement
- Audit trail for `/apply(mode:"pr")`
- Rate limiting for `http.*` effects

### 2.0.0 (October 2026)
- WebAssembly sandbox for custom check evaluators
- Signed emitter registry with trust anchors
- SLSA Level 4 provenance

---

## 🙏 Acknowledgments

This release represents months of rigorous testing, security hardening, and determinism validation. Special thanks to all contributors and early adopters who provided feedback and battle-tested the MCP endpoints.

---

## 📞 Support

- **Issues:** [GitHub Issues](https://github.com/axiom-lang/axiom/issues)
- **Discussions:** [GitHub Discussions](https://github.com/axiom-lang/axiom/discussions)
- **Security:** security@axiom-lang.org
- **Enterprise:** enterprise@axiom-lang.org

---

**Full Changelog:** [CHANGELOG.md](CHANGELOG.md)  
**Upgrade Guide:** [docs/versioning.md](docs/versioning.md)  
**Security Policy:** [SECURITY.md](SECURITY.md)
