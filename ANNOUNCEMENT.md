# AXIOM 1.0.0 - Release Announcement

## 🎉 Production-Ready: Deterministic Infrastructure Generation

AXIOM 1.0.0 is now available - a deterministic code generation system with strict capability sandbox and real-time validation.

### ✨ Highlights

**100% Deterministic Builds**
- Same input → Same output (including manifest metadata)
- `buildId = SHA256(IR + profile)` - no timestamps, no randomness
- Reproducible across machines, timezones, environments

**Strict Capability Model**
- `http.*` requires `net()` capability
- `scan.artifacts.*` requires `fs()` capability  
- `ai.*` requires `ai()` capability
- Violations blocked at validation-time with clear diagnostics

**Real Evidence, Not Assumptions**
- `max_dependencies` counted from package.json
- `frontend_bundle_kb` summed from actual bytes
- `no_analytics` verified via denylist scan
- Int64/Boolean measurements, not text claims

**Complete MCP API**
- `/parse` - Source → IR
- `/validate` - IR capability check
- `/generate` - IR → Artifacts
- `/check` - Profile constraint enforcement
- `/reverse` - Artifacts → IR (NEW)
- `/diff` - IR comparison (NEW)
- `/apply` - Manifest → FS or PR (NEW)

### 📦 Installation

```bash
npm install @axiom/core@1.0.0 @axiom/engine@1.0.0 @axiom/mcp@1.0.0
```

### 🔐 Security

- Capability sandbox tested with negative test suite
- Deterministic builds eliminate timing attacks
- SBOM + signed hashes for verification
- 12-month LTS support with security patches

### 📄 Documentation

- [Release Notes](RELEASE-NOTES-1.0.0.md) - Full feature breakdown
- [Security Policy](SECURITY.md) - Threat model & reporting
- [Versioning](docs/versioning.md) - Schema compatibility
- [GO/NO-GO Report](GO-NOGO-REPORT.md) - Complete validation evidence

### 📥 Downloads

- **Bundle:** axiom-1.0.0-bundle.tar.gz
- **SHA256:** `07E1C826914DE13C7D9C4CA863F8B2B0BFC13E6C520BC4AA9C4E4568330820BF`
- **SBOM:** sbom.json (CycloneDX 1.4)

---

## Twitter/LinkedIn Blurb

> Just shipped AXIOM 1.0.0 🎉
> 
> Deterministic infrastructure generation with:
> • 100% reproducible builds (hash-based IDs, no timestamps)
> • Strict capability sandbox (http/fs/ai validation)
> • Real evidence measurements (not mock values)
> • Complete MCP API (/reverse, /diff, /apply)
> 
> Same input → Same output. Every time. Everywhere.
> 
> npm install @axiom/core@1.0.0
> 
> [Link to release]
> #infrastructure #determinism #devtools

---

## HackerNews Post

**Title:** AXIOM 1.0.0 – Deterministic Infrastructure Generation with Capability Sandbox

**Text:**

We've just released AXIOM 1.0.0, a code generation system focused on determinism and security.

Key features:

• **100% deterministic manifests**: buildId = SHA256(IR + profile). No timestamps, no randomness. Same input produces identical output across machines.

• **Capability sandbox**: All effects (http.*, scan.artifacts.*, ai.*) require explicit capability grants. Violations are blocked at validation-time.

• **Real measurements**: Profile enforcement scans actual artifacts - max_dependencies counted from package.json, bundle sizes summed from bytes, analytics detected via denylist.

• **Complete MCP API**: /parse, /validate, /generate, /check, plus new /reverse (artifacts → IR), /diff (IR comparison), /apply (manifest → filesystem/PR).

Everything was validated with a cold-start test suite (5/5 tests passed):
- Determinism (manifest SHA256 identical R1 vs R2)
- Endpoints (functional end-to-end)
- Evidence (numeric Int64/Boolean types)
- Sandbox (negative tests correctly reject)
- CI (golden snapshots detect corruption)

Download: axiom-1.0.0-bundle.tar.gz + SHA256 hash + SBOM

GitHub: [repo link]
Docs: SECURITY.md, versioning.md, GO-NOGO-REPORT.md
LTS: 12 months security support

Questions welcome!

---

_Built with no AI in the generation engine. Interpretations are external._
