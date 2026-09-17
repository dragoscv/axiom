# 🚀 AXIOM v1.0.17 - Official Release Announcement

**Release Date**: October 21, 2025  
**Status**: ✅ PUBLISHED TO NPM  
**PR**: [#3 - Merged](https://github.com/dragoscv/axiom/pull/3)

---

## 📦 Published Packages

### @codai/axiom-engine@1.0.17
- **npm**: https://www.npmjs.com/package/@codai/axiom-engine
- **Version**: 1.0.17
- **Published**: ✅ October 21, 2025
- **Size**: 21.1 kB (79.0 kB unpacked)
- **Files**: 32 files

### @codai/axiom-mcp@1.0.17
- **npm**: https://www.npmjs.com/package/@codai/axiom-mcp
- **Version**: 1.0.17
- **Published**: ✅ October 21, 2025
- **Size**: 8.4 kB (32.7 kB unpacked)
- **Files**: 6 files

---

## 🎯 Major Enhancements

### 1. **Manifest Content Fallback** (Store-less Operation)
Artifacts can now embed content directly via `contentUtf8` or `contentBase64`, enabling faster apply operations without cache dependencies.

**Fallback Chain**:
```typescript
1. artifact.contentUtf8 → Buffer.from(utf-8)     // Fastest path
2. artifact.contentBase64 → Buffer.from(base64)  // Binary content
3. artifactStore.get(sha256)                      // Cache fallback
4. throw ERR_ARTIFACT_CONTENT_MISSING            // Error
```

**Benefits**:
- ✅ Small artifacts (README, configs) don't require cache
- ✅ Faster apply for embedded content
- ✅ Reduced I/O operations for frequently used files

### 2. **Versioned Artifact Cache**
Cache structure upgraded from `.axiom/cache/` to `.axiom/cache/v1/` for future compatibility.

**Benefits**:
- ✅ Future-proof cache structure for format evolution
- ✅ Clear migration path for breaking changes
- ✅ Backward compatible with existing cache

### 3. **Physical Filesystem Writes**
Complete implementation of real filesystem writes with comprehensive validation.

**Features**:
- ✅ Real `fs/promises.writeFile()` under `out/` directory
- ✅ SHA256 post-write verification with `ArtifactStore.verify()`
- ✅ POSIX path normalization (guaranteed forward slashes)
- ✅ Auto-creation of `out/` directory structure

### 4. **Comprehensive Security**
Enhanced path validation with multiple security layers.

**Protection Against**:
- ✅ Absolute paths (`/etc/passwd`) → REJECTED
- ✅ Path traversal (`../../../sensitive`) → REJECTED
- ✅ Mid-path traversal (`safe/../evil/hack.txt`) → REJECTED
- ✅ Only safe relative paths under `out/` → ACCEPTED

**Test Coverage**: 4 comprehensive security test scenarios

### 5. **Check Evaluator AND Logic**
Fixed aggregation logic to properly evaluate all checks.

**Implementation**:
- ✅ All checks marked with `evaluated: true`
- ✅ Aggregate `passed` requires ALL checks to pass
- ✅ Proper AND logic (not OR)

---

## 🧪 Test Coverage

### New Test Files (533 Lines)
| File | Lines | Purpose |
|------|-------|---------|
| `apply-physical-smoke.test.ts` | 133 | End-to-end physical write validation |
| `path-normalization-deepcopy.test.ts` | 78 | POSIX guarantee + no mutation |
| `apply-security.test.ts` | 145 | 4 comprehensive security scenarios |
| `check-aggregate-and.test.ts` | 177 | AND aggregation logic |

### Test Results
```bash
✅ ALL TESTS GREEN
Artifacts: 16 
Manifest: 019e79c5d9ff42b29e3901b1dbf551637c9dbeb0ef207a791e06d75203788675
OK
```

---

## 📊 What Changed from v1.0.16

| Feature | v1.0.16 | v1.0.17 |
|---------|---------|---------|
| **Cache Path** | `.axiom/cache/` | `.axiom/cache/v1/` ✨ |
| **Content Source** | Store only | contentUtf8/Base64 → store ✨ |
| **Security Tests** | Basic | 4 comprehensive scenarios ✨ |
| **Test Files** | 2 new | 4 new (+533 lines) ✨ |
| **Proof Doc** | None | PROOF_1.0.17.md (8 proofs) ✨ |
| **POSIX Guarantee** | Yes | Yes + validated |
| **SHA256 Validation** | Yes | Yes + post-write |

---

## 🔧 Migration Guide

### For Users

**No breaking changes!** Simply upgrade:

```bash
# Upgrade engine
npm install @codai/axiom-engine@1.0.17

# Upgrade MCP server
npm install @codai/axiom-mcp@1.0.17
```

### Cache Migration
- ✅ **Automatic**: Existing `.axiom/cache/` files remain readable
- ✅ **New writes**: Go to `.axiom/cache/v1/` automatically
- ✅ **No action required**: Transparent migration

### Manifest Schema
- ✅ **Backward compatible**: `contentUtf8`/`contentBase64` are optional
- ✅ **Old manifests**: Work without changes
- ✅ **New manifests**: Can leverage embedded content

---

## 📝 Proof Document

Full validation proof available in `PROOF_1.0.17.md`:

### 8 Comprehensive Proofs
1. ✅ **Deterministic SHA256**: Identical hash on repeat generation
2. ✅ **POSIX Paths**: Zero backslashes across all platforms
3. ✅ **Check Evaluator AND**: All evidence evaluated correctly
4. ✅ **Physical FS Apply**: Real files written to disk
5. ✅ **Security Anti-Traversal**: All attack vectors blocked
6. ✅ **SHA256 Post-Write**: Integrity validation working
7. ✅ **Content Fallback**: 3-tier resolution chain functional
8. ✅ **Versioned Cache**: v1 structure in place

---

## 🎉 Acknowledgments

This release represents a significant enhancement to AXIOM's filesystem apply capabilities, security posture, and developer experience. Special thanks to all contributors and testers.

### Key Improvements
- **Reliability**: SHA256 validation ensures file integrity
- **Security**: Comprehensive path validation protects against traversal attacks
- **Performance**: Embedded content reduces cache dependencies
- **Future-proof**: Versioned cache enables seamless format evolution

---

## 📚 Resources

- **GitHub Repository**: https://github.com/dragoscv/axiom
- **npm - axiom-engine**: https://www.npmjs.com/package/@codai/axiom-engine
- **npm - axiom-mcp**: https://www.npmjs.com/package/@codai/axiom-mcp
- **Documentation**: See `README.md` and `CHANGELOG.md`
- **Proof Document**: See `PROOF_1.0.17.md`

---

## 🚀 Next Steps

Try the new version:

```bash
# Install latest
npm install -g @codai/axiom-mcp@1.0.17

# Use embedded content in manifests
{
  "artifacts": [{
    "path": "out/README.md",
    "sha256": "...",
    "bytes": 100,
    "contentUtf8": "# My Project\n\nQuick start..."
  }]
}

# Apply with automatic fallback
axiom_apply --manifest manifest.json --mode fs
```

---

**Happy coding with AXIOM v1.0.17!** 🎯
