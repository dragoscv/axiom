# Security Policy

## Supported Versions

| Version | Support Status | Security Patches |
|---------|---------------|------------------|
| 1.x     | ✅ Active LTS | Until Oct 2026   |
| 0.x     | ❌ End of Life | No patches       |

## Security Model

### Capability Sandbox

AXIOM enforces a **strict capability model** at validation time:

- **`http.*` effects** (e.g., `http.healthy()`) require explicit `net("http")` or `net("https")` capability
- **`scan.artifacts.*` effects** require explicit `fs("./path")` capability  
- **`ai.*` effects** require explicit `ai("provider")` capability

**Without declared capabilities**, validation returns `ok: false` with clear diagnostics.

**Example rejection:**
```json
{
  "ok": false,
  "diagnostics": [{
    "message": "Check 'api' uses http.* but capability net(...) is missing"
  }]
}
```

### Evaluation Sandbox

- Check evaluators run **without `eval()`** or dynamic code execution
- Strict allowlist for effects: `http.healthy`, `scan.artifacts.no_personal_data`, etc.
- No network access by default in emitters; profiles must explicitly enable via capabilities

### Deterministic Generation

- **buildId** = SHA256(normalized IR + profile) - no time-based oracle attacks
- **createdAt** = `deterministic-{hash}` - eliminates timing side-channels
- **Artifact integrity** = SHA256 hashes enable tamper detection

### Threat Model

| Threat | Mitigation | Status |
|--------|-----------|--------|
| Capability bypass | Validator enforces before generation | ✅ Mitigated |
| Time-based oracle attacks | Deterministic manifest fields | ✅ Mitigated |
| Artifact tampering | SHA256 hashes + golden snapshots | ✅ Detectable |
| Profile constraint bypass | Real measurements from artifacts | ✅ Mitigated |
| Code injection via IR | No eval(), strict effect allowlist | ✅ Mitigated |

## Reporting Vulnerabilities

**DO NOT** open public GitHub issues for security vulnerabilities.

**Contact:** security@axiom-lang.org (or open a private security advisory)

**Response SLA:**
- **Triage:** 72 hours
- **Critical fix:** 7 days
- **High fix:** 14 days
- **Medium/Low fix:** Next minor release

**Disclosure Policy:**
- Coordinated disclosure after patch is available
- CVE assignment for High/Critical vulnerabilities
- Public acknowledgment in CHANGELOG and Security Advisories

## Security Hardening Roadmap

### Planned for 1.1.0
- [ ] Signed manifests with detached signatures
- [ ] Policy signatures for profile constraints
- [ ] Emitter allowlist with hash pinning
- [ ] `profile.lock` for reproducible builds

### Planned for 1.2.0
- [ ] Runtime capability enforcement (not just validation-time)
- [ ] Audit trail for `/apply(mode:"pr")` operations
- [ ] Rate limiting for `http.*` effects in check runners
- [ ] SBOM generation as part of `/generate` output

### Planned for 2.0.0
- [ ] WebAssembly sandbox for custom check evaluators
- [ ] Signed emitter registry with trust anchors
- [ ] Verifiable build attestations (SLSA Level 4)

## Best Practices

### For IR Authors
1. **Minimize capabilities** - Only request `net/fs/ai` when absolutely necessary
2. **Validate constraints** - Use profile `checks` to enforce security properties
3. **Avoid PII** - Use `scan.artifacts.no_personal_data()` policy check
4. **Pin emitter versions** - Future: use `profile.lock` for reproducibility

### For Emitter Developers
1. **No network by default** - Require explicit `net()` capability grant
2. **Validate inputs** - Never trust IR content without validation
3. **Audit file writes** - Only write to declared `target` paths
4. **Document side effects** - Clearly specify what capabilities your emitter requires

### For Profile Maintainers
1. **Real measurements** - Don't hardcode constraint values, measure artifacts
2. **Conservative defaults** - BUDGET profile as baseline, EDGE for advanced features
3. **Test enforcement** - Verify profile checks reject violations (negative tests)

## Security Contact

- **Email:** security@axiom-lang.org
- **PGP Key:** Available at https://axiom-lang.org/.well-known/pgp-key.txt
- **GitHub Security Advisories:** https://github.com/axiom-lang/axiom/security/advisories

---

**Last Updated:** October 20, 2025  
**Version:** 1.0.0
