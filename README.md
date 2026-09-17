
````markdown

# AXIOM — AI‑native intention language & deterministic engine

**Fără AI în engine. Fără framework-uri în limbaj.**  
Agenții (Claude/GPT/etc.) pot genera AXIOM, iar **engine-ul** îl parsează/validează/generează/verifică.

---

## 📦 Install & Use

**Install ONLY the MCP server** (all internal packages included):

```bash
npm install -D @codai/axiom-mcp
```

**Start the MCP server:**

```bash
npx axiom-mcp
# Server starts on http://localhost:3411
```

**MCP config auto-installed at:** `~/.mcp/servers/axiom.json`

---

## 🔌 MCP Endpoints

All endpoints available at `http://localhost:3411`:

| Endpoint | Description | Input | Output |
|----------|-------------|-------|--------|
| **POST /parse** | Parse `.axm` source to IR | `{source: string}` | `{ir: TAxiomIR, diagnostics: []}` |
| **POST /validate** | Validate IR semantics | `{ir: TAxiomIR}` | `{diagnostics: []}` |
| **POST /generate** | Generate artifacts from IR | `{ir: TAxiomIR, profile?: string}` | `{manifest: {...}, artifacts: [...]}` |
| **POST /check** | Run policy checks | `{ir: TAxiomIR}` | `{checks: [...]}` |
| **POST /reverse** | Reverse engineer IR from repo | `{path: string}` | `{ir: TAxiomIR, diagnostics: []}` |
| **POST /diff** | Generate IR diff patches | `{old: TAxiomIR, new: TAxiomIR}` | `{patches: [...]}` |
| **POST /apply** | Apply patches to filesystem | `{patches: [...], target: string}` | `{files: [...]}` |

**Example:**

```bash
curl -X POST http://localhost:3411/parse \
  -H 'Content-Type: application/json' \
  -d '{"source": "product Blog {\n  subtype webapp\n  capability net()\n}"}'
```

---

## 🏗️ For Development (Monorepo)

```bash
pnpm install
pnpm build

# Run tests
pnpm test
```"/\\"/g')'"}'

# Generează artefacte din IR
curl -s http://localhost:3411/generate -H 'content-type: application/json'   -d @examples/blog.ir.json

# Rulează mini testul end-to-end
pnpm test
```

## 🔄 Stateless Pipelines (v1.0.19+)

**NEW:** Manifests now support **inline artifact content** for stateless workflows!

### What is a Stateless Pipeline?

In traditional workflows, `generate()` stores artifact content in an in-memory cache, which `apply()` retrieves later. However, in **stateless environments** like MCP tool invocations (e.g., Claude Desktop), the cache is lost between calls.

**Solution:** For files ≤ 256 KiB, `generate()` embeds content directly in the manifest as:
- `contentUtf8` for text files (UTF-8 encoded)
- `contentBase64` for binary files (Base64 encoded)

### Usage Example

```typescript
// Step 1: Generate manifest (content embedded for small files)
const { manifest } = await generate(ir, outRoot, "edge");

// Step 2: Apply manifest in new process/context (stateless!)
// No artifact store needed - content is in manifest
const result = await apply({
  manifest,
  mode: "fs",
  repoPath: targetRepo
});

// ✅ Files written successfully from embedded content
```

### Configuration

Control inline content behavior via environment variables:

```bash
# Enable/disable inline content (default: enabled)
export AXIOM_INLINE_CONTENT=1

# Size threshold in bytes (default: 262144 = 256 KiB)
export AXIOM_INLINE_THRESHOLD_BYTES=262144
```

### Content Fallback Chain

`apply()` uses a 4-tier fallback strategy:

1. **`artifact.contentUtf8`** → Embedded UTF-8 text (highest priority)
2. **`artifact.contentBase64`** → Embedded Base64 binary
3. **`artifactStore.get(sha256)`** → Cached content (if available)
4. **`ERR_ARTIFACT_CONTENT_MISSING`** → Clear error (no content found)

### Benefits

- ✅ **MCP Compatible**: Works in stateless tool invocations
- ✅ **Network Transfer**: Self-contained manifests for remote apply
- ✅ **Fast Deployment**: No cache dependency for small projects
- ✅ **Reproducibility**: Complete artifacts in manifest for archival

### Technical Details

**Encoding Decision:**
```typescript
if (bytes <= 256_KiB && validUTF8) {
  artifact.contentUtf8 = content.toString('utf-8');
} else if (bytes <= 256_KiB) {
  artifact.contentBase64 = content.toString('base64');
}
// Files > 256 KiB: content via artifact store only
```

**SHA256 Validation:** All written files verified post-write regardless of content source.

## 🔒 Filesystem Apply: Real Writes + Verification (v1.0.20+)

### Production-Grade File Operations

AXIOM `apply()` implements **defense-in-depth** validation for guaranteed file integrity:

#### ✅ Pre-Write Validation
Before writing any file, content is validated against manifest expectations:
```typescript
// Content must match manifest SHA256
if (ArtifactStore.hash(content) !== artifact.sha256) {
  throw ERR_SHA_MISMATCH;
}

// Size must match manifest bytes
if (content.length !== artifact.bytes) {
  throw ERR_SIZE_MISMATCH;
}
```

#### ✅ Post-Write Verification
After writing, files are read back and re-verified:
```typescript
// Write file
await writeFile(fullPath, content);

// Read back from disk
const writtenContent = await readFile(fullPath);

// Verify disk content matches expected SHA256
if (ArtifactStore.hash(writtenContent) !== artifact.sha256) {
  throw ERR_POST_WRITE_VERIFY; // Disk corruption detected
}
```

### Path Security & Validation

#### Strict POSIX Path Enforcement
All artifact paths MUST use forward slashes only:
```typescript
// ✅ VALID
artifact.path = "src/components/Button.tsx"

// ❌ INVALID - Will throw ERR_POSIX_ONLY
artifact.path = "src\\components\\Button.tsx"
```

#### Cross-Platform repoPath Support
`apply()` accepts both Windows and Unix paths:
```typescript
// Windows absolute path
await apply({ manifest, mode: "fs", repoPath: "E:\\GitHub\\project" });
await apply({ manifest, mode: "fs", repoPath: "E:/GitHub/project" });

// Unix absolute path  
await apply({ manifest, mode: "fs", repoPath: "/home/user/project" });

// Relative path (resolved automatically)
await apply({ manifest, mode: "fs", repoPath: "./project" });
```

#### Security Protections
```typescript
// ❌ Rejected: Absolute paths in artifacts
artifact.path = "/etc/passwd" // Error

// ❌ Rejected: Path traversal
artifact.path = "../../../etc/passwd" // Error

// ❌ Rejected: Mid-path traversal  
artifact.path = "safe/../../../etc/passwd" // Error

// ✅ Accepted: Relative paths under out/
artifact.path = "src/app/page.tsx" // OK
```

### Apply Result Summary

Enhanced observability with statistics:
```typescript
const result = await apply({ manifest, mode: "fs", repoPath });

console.log(result.summary);
// {
//   totalFiles: 42,
//   totalBytes: 1048576
// }
```

### Error Handling

Comprehensive error codes for debugging:

| Error Code | Cause | Solution |
|------------|-------|----------|
| `ERR_POST_WRITE_VERIFY` | Disk SHA256 mismatch after write | Check filesystem, disk space, permissions |
| `ERR_POST_WRITE_SIZE` | File size mismatch after write | Check disk space, filesystem limits |
| `ERR_SHA_MISMATCH` | Content doesn't match manifest (pre-write) | Regenerate manifest or verify content |
| `ERR_SIZE_MISMATCH` | Content size doesn't match manifest | Regenerate manifest or verify content |
| `ERR_POSIX_ONLY` | Artifact path contains backslash | Use forward slashes only |
| `ERR_ARTIFACT_CONTENT_MISSING` | No content source available | Run generate() or include inline content |

### Complete Example

```typescript
import { apply } from "@codai/axiom-engine";

const result = await apply({
  manifest: generatedManifest,
  mode: "fs",
  repoPath: "E:/GitHub/my-project"
});

if (!result.success) {
  console.error("Apply failed:", result.error);
  process.exit(1);
}

console.log(`✅ Success!`);
console.log(`Files written: ${result.summary.totalFiles}`);
console.log(`Total bytes: ${result.summary.totalBytes}`);
console.log(`Paths:`, result.filesWritten);
// ["out/src/app/page.tsx", "out/package.json", ...]
```

## 🌐 Custom Output Locations with AXIOM_OUT_ROOT (v1.0.21+)

### Enterprise-Grade Filesystem Flexibility

AXIOM now supports **custom output directories** via the `AXIOM_OUT_ROOT` environment variable, enabling:
- Enterprise deployments with specific artifact locations
- Network drives and mounted volumes
- Multi-drive projects (Windows: C:, D:, E:, etc.)
- CI/CD pipelines with custom staging directories

### Basic Usage

```bash
# Write to custom directory
export AXIOM_OUT_ROOT=/mnt/artifacts
npx axiom-mcp

# Windows: Write to D: drive
set AXIOM_OUT_ROOT=D:\BUILD_OUTPUT
npx axiom-mcp

# Relative path (resolved from repoPath)
export AXIOM_OUT_ROOT=custom-out
```

### How It Works

**Default Behavior (no AXIOM_OUT_ROOT):**
```typescript
// Files written to: <repoPath>/out/
await apply({ manifest, mode: "fs", repoPath: "/home/user/project" });
// Result: /home/user/project/out/src/app/page.tsx
```

**With AXIOM_OUT_ROOT (absolute path):**
```typescript
process.env.AXIOM_OUT_ROOT = "/mnt/network-drive/artifacts";
await apply({ manifest, mode: "fs", repoPath: "/home/user/project" });
// Result: /mnt/network-drive/artifacts/src/app/page.tsx
```

**With AXIOM_OUT_ROOT (relative path):**
```typescript
process.env.AXIOM_OUT_ROOT = "custom-out";
await apply({ manifest, mode: "fs", repoPath: "/home/user/project" });
// Result: /home/user/project/custom-out/src/app/page.tsx
```

### Cross-Drive Support (Windows)

Write artifacts to different physical drives:

```typescript
// Windows: Write from C: project to D: drive
process.env.AXIOM_OUT_ROOT = "D:\\AXIOM_ARTIFACTS";
await apply({ 
  manifest, 
  mode: "fs", 
  repoPath: "C:\\Users\\user\\project" 
});

// Result: D:\AXIOM_ARTIFACTS\src\app\page.tsx
// Source repo: C:\Users\user\project (unchanged)
```

### Enhanced Response Fields

New optional fields for transparency:

```typescript
const result = await apply({ manifest, mode: "fs", repoPath });

// Relative paths (POSIX format, always included)
console.log(result.filesWritten);
// ["out/src/app/page.tsx", "out/package.json"]

// NEW: Absolute paths (full transparency)
console.log(result.filesWrittenAbs);
// [
//   "D:\\AXIOM_ARTIFACTS\\src\\app\\page.tsx",
//   "D:\\AXIOM_ARTIFACTS\\package.json"
// ]

// NEW: Detailed failure tracking
if (!result.success && result.failures) {
  result.failures.forEach(f => {
    console.error(`Failed: ${f.path}`);
    console.error(`Reason: ${f.reason}`);
    console.error(`Expected: ${f.expected?.sha256}`);
    console.error(`Actual: ${f.actual?.sha256}`);
  });
}
```

### Configuration Reference

| Environment Variable | Type | Description | Default |
|---------------------|------|-------------|---------|
| `AXIOM_OUT_ROOT` | string | Custom output directory (absolute or relative) | `<repoPath>/out` |

### Use Cases

1. **Network Drives**: `AXIOM_OUT_ROOT=//server/share/artifacts`
2. **Temporary Builds**: `AXIOM_OUT_ROOT=/tmp/axiom-build-${BUILD_ID}`
3. **Multi-Stage CI/CD**: 
   - Stage 1: `AXIOM_OUT_ROOT=/build/stage1`
   - Stage 2: `AXIOM_OUT_ROOT=/build/stage2`
4. **Developer Overrides**: Keep source clean, write to separate location
5. **Windows Multi-Drive**: Separate artifacts to faster SSD (`D:\AXIOM`)

### Comprehensive Logging

All filesystem operations are logged to stderr for debugging:

```stderr
[apply] Starting filesystem apply
[apply]   repoRoot: C:\Users\user\project
[fs-axiom] Using AXIOM_OUT_ROOT: D:\AXIOM_ARTIFACTS
[apply]   outRoot: D:\AXIOM_ARTIFACTS
[apply]   repoAbs: C:\Users\user\project
[apply] Processing artifact: src/app/page.tsx
[fs-axiom] Extracting content for: src/app/page.tsx
[fs-axiom]   → Using contentUtf8 (1024 chars)
[fs-axiom] Writing: D:\AXIOM_ARTIFACTS\src\app\page.tsx
[fs-axiom]   → mkdir: D:\AXIOM_ARTIFACTS\src\app
[fs-axiom]   → Written to disk
[fs-axiom]   → Read-back size: 1024 bytes
[fs-axiom]   → Read-back SHA256: abc123...
[fs-axiom]   ✓ Size OK
[fs-axiom]   ✓ Hash OK
[apply]   ✓ SUCCESS: out/src/app/page.tsx
[apply] Complete: success=true, files=1, failures=0
```

### Security & Validation

- ✅ Path validation still enforced (no traversal attacks)
- ✅ POSIX path requirements unchanged (forward slashes only)
- ✅ SHA256 verification for all writes
- ✅ Post-write read-back validation
- ✅ Filesystem errors surfaced in `failures[]` array

### Testing & Validation

Comprehensive test suite validates all scenarios:

```bash
# Run enhanced filesystem tests
cd packages/axiom-tests
npx vitest run src/apply-enhanced-fs.test.ts

# Test matrix:
# ✅ Test 1: Relative path (default behavior)
# ✅ Test 2: Absolute path support
# ✅ Test 3: AXIOM_OUT_ROOT override
# ✅ Test 4: Cross-drive write (Windows D:)
```

**Test Results:** 4/4 tests passing (100% success rate)

### Independent Test Tool

Use `fs-probe-write` to test filesystem capabilities:

```bash
# Test cross-drive write independently
curl -X POST http://localhost:3411/fs-probe-write \
  -H 'Content-Type: application/json' \
  -d '{
    "destAbs": "D:\\TEST\\file.txt",
    "contentUtf8": "Hello World"
  }'

# Response:
# {
#   "success": true,
#   "absPath": "D:\\TEST\\file.txt",
#   "hash": "a591a6d40bf420404a011733cfb7b190...",
#   "size": 11
# }
```

## 🔒 Safe repoPath Resolution (v1.0.22+)

### Fail-Closed Protection Against Accidental HOME Writes

AXIOM v1.0.22 introduces **deterministic repository path resolution** with fail-closed protection to prevent accidental writes to your HOME directory when using relative paths like `"."`.

### The Problem

When using `repoPath: "."` without proper context:
```typescript
// ❌ DANGEROUS: If process.cwd() happens to be $HOME...
process.chdir(os.homedir()); // Accidentally in HOME
await apply({ manifest, mode: "fs", repoPath: "." });
// 💥 Writes files to ~/out/... (your HOME directory!)
```

### The Solution: Three-Layer Safety

#### 1. **Absolute Paths (Recommended)**
```typescript
// ✅ SAFEST: Always use absolute paths
await apply({
  manifest,
  mode: "fs",
  repoPath: "/home/user/my-project" // Explicit, no ambiguity
});
```

#### 2. **AXIOM_REPO_ROOT Override**
```typescript
// ✅ SAFE: Set explicit repo root for relative paths
process.env.AXIOM_REPO_ROOT = "/home/user/my-project";
await apply({ manifest, mode: "fs", repoPath: "." });
// Resolves to: /home/user/my-project
```

```bash
# Environment variable usage
export AXIOM_REPO_ROOT=/workspace/my-project
npx axiom-mcp
```

#### 3. **Git Repository Detection**
```typescript
// ✅ SAFE: Automatic Git root detection
// If process.cwd() = /home/user/my-project/src/components
// And /home/user/my-project/.git exists
await apply({ manifest, mode: "fs", repoPath: "." });
// Resolves to: /home/user/my-project (Git root)
```

### Fail-Closed Protection

If none of the above apply and `repoPath` resolves to HOME:

```typescript
// ❌ BLOCKED: Resolution would write to HOME
await apply({ manifest, mode: "fs", repoPath: "." });

// Result:
{
  success: false,
  error: "ERR_REPOPATH_RELATIVE_UNSAFE: Relative repoPath \".\" resolved to HOME directory (/home/user). This is unsafe. Please pass an absolute repoPath or set AXIOM_REPO_ROOT environment variable.",
  filesWritten: [], // Zero files written
  failures: [{
    path: "(repoPath resolution)",
    reason: "ERR_REPOPATH_RELATIVE_UNSAFE: ..."
  }]
}
```

### Resolution Algorithm

```
1. If repoPath is absolute → Use it directly
2. Else if AXIOM_REPO_ROOT is set (absolute, existing) → Use it as base
3. Else try Git detection:
   - Walk up from process.cwd() looking for .git
   - If found → Use Git root as base
4. Else resolve relative to process.cwd()
5. If resolved path == HOME → FAIL-CLOSED (throw ERR_REPOPATH_RELATIVE_UNSAFE)
6. Return absolute repository root
```

### Environment Variables

| Variable | Type | Required | Description |
|----------|------|----------|-------------|
| `AXIOM_REPO_ROOT` | string | No | Explicit repository root (must be absolute, must exist) |
| `AXIOM_OUT_ROOT` | string | No | Custom output directory (see v1.0.21 features) |

### Error Codes

| Error Code | Cause | Solution |
|------------|-------|----------|
| `ERR_REPOPATH_RELATIVE_UNSAFE` | Relative repoPath resolved to HOME | Use absolute repoPath or set `AXIOM_REPO_ROOT` |
| `ERR_AXIOM_REPO_ROOT_MUST_BE_ABSOLUTE` | `AXIOM_REPO_ROOT` is not absolute | Provide absolute path like `/workspace/project` |
| `ERR_AXIOM_REPO_ROOT_NOT_FOUND` | `AXIOM_REPO_ROOT` directory doesn't exist | Create directory or fix path |

### Best Practices

```typescript
// ✅ BEST: Always use absolute paths in production
await apply({
  manifest,
  mode: "fs",
  repoPath: path.resolve(process.cwd(), "my-project")
});

// ✅ GOOD: Set AXIOM_REPO_ROOT for containerized environments
// Dockerfile:
// ENV AXIOM_REPO_ROOT=/app
process.env.AXIOM_REPO_ROOT = "/app";

// ✅ ACCEPTABLE: Rely on Git detection (local development only)
// Only safe if you're confident .git exists and cwd is within repo

// ❌ AVOID: Relative paths without AXIOM_REPO_ROOT or Git context
await apply({ manifest, mode: "fs", repoPath: "." }); // Risky!
```

### MCP Server Integration

The MCP server automatically provides friendly error messages:

```bash
curl -X POST http://localhost:3411/apply \
  -H 'Content-Type: application/json' \
  -d '{"manifest": {...}, "mode": "fs", "repoPath": "."}'

# Response (if unsafe):
{
  "success": false,
  "errorCode": "ERR_REPOPATH_RELATIVE_UNSAFE",
  "hint": "Furnizează repoPath absolut sau setează AXIOM_REPO_ROOT la rădăcina repo-ului.",
  "error": "ERR_REPOPATH_RELATIVE_UNSAFE: ...",
  "filesWritten": [],
  "failures": [...]
}
```

### Testing

Comprehensive test coverage for all scenarios:

```bash
# Run safety tests
cd packages/axiom-tests
npx vitest run src/apply-repopath-dot.test.ts

# Test matrix:
# ✅ T1: FAIL-CLOSED when cwd=HOME and repoPath="." (no AXIOM_REPO_ROOT)
# ✅ T2: SUCCESS when AXIOM_REPO_ROOT is set
# ✅ T3: SUCCESS with absolute repoPath
# ✅ T4: SUCCESS for cross-drive writes (Windows)
```

**Test Results:** 4/4 tests passing (100% success rate)

### Migration Guide

**From v1.0.21 to v1.0.22:**

No breaking changes! Existing code works as before:

```typescript
// ✅ Still works (if context is safe)
await apply({ manifest, mode: "fs", repoPath: absolutePath });

// ✅ Now safer (blocks accidental HOME writes)
await apply({ manifest, mode: "fs", repoPath: "." });
// Only succeeds if:
// - AXIOM_REPO_ROOT is set, OR
// - Git root detected, OR
// - Resolution doesn't land in HOME
```

**Action Required:**

1. **Review relative `repoPath` usage** in your codebase
2. **Prefer absolute paths** for production deployments
3. **Set `AXIOM_REPO_ROOT`** in CI/CD environments
4. **Test with v1.0.22** before deploying

---

## 🛡️ Filesystem Semantics & Safety (v1.0.24 Hardening)

### Atomic Write Guarantees

**Same-Volume Writes:**
- Temporary file created in **same directory** as target file
- Atomic `rename()` within same volume/directory
- Physical guarantee: either old file OR new file exists, never corrupted state

**Cross-Volume Writes (AXIOM_OUT_ROOT on different drive):**
- Temporary file created in **target directory** (on target volume)
- `rename()` is local operation (atomic within volume)
- NOT cross-drive move (which would be non-atomic copy+delete)

**Universal Guarantee:**
- All writes: `write → fsync → rename → read-back + SHA256 verification`
- `success=true` **ONLY IF** physical file exists with correct hash

### Path Resolution Algorithms

**resolveRepoRoot() - Fail-Closed Protection:**

```
1. If repoPath is absolute → normalize and return
2. If AXIOM_REPO_ROOT env set (absolute, existing) → use for relative paths
3. Try Git detection: walk up from cwd to find .git
4. If resolved path is HOME and repoPath was relative → THROW ERR_REPOPATH_RELATIVE_UNSAFE
5. Return absolute path
```

**resolveArtifactAbs() - POSIX-Only Validation:**

```
1. Unicode NFC normalization (consistent representation)
2. Reject backslashes (\) - POSIX forward slashes only
3. Reject path traversal (..) - no directory escape
4. Reject absolute paths (/etc, C:\) - relative only
5. [Windows] Reject reserved names (CON, PRN, NUL, AUX, COM1-9, LPT1-9)
6. [Windows] Reject trailing spaces/dots (filesystem incompatibility)
7. [Windows] Reject invalid chars (<>:"|?*)
8. Normalize POSIX path → split segments → join with outRootAbs
9. Return {absDir, absFile} - fully qualified paths
```

### Path Policy Summary

| Policy | Validation | Error Code |
|--------|-----------|------------|
| **POSIX-only** | No backslashes | `ERR_ARTIFACT_PATH_BACKSLASH` |
| **Relative paths** | No `/etc` or `C:\` | `ERR_ARTIFACT_PATH_ABSOLUTE` |
| **No traversal** | No `..` segments | `ERR_ARTIFACT_PATH_TRAVERSAL` |
| **Reserved names** | No CON/PRN/AUX/COM*/LPT* (Windows) | `ERR_ARTIFACT_PATH_RESERVED_WINDOWS` |
| **Trailing chars** | No trailing space/dot (Windows) | `ERR_ARTIFACT_PATH_TRAILING` |
| **Invalid chars** | No `<>:"\|?*` (Windows) | `ERR_ARTIFACT_PATH_INVALID_CHARS` |
| **Unicode** | NFC normalized | (automatic normalization) |

### ApplyResult Interface

**Fields Guaranteed When `success=true`:**

```typescript
interface ApplyResult {
  success: true;
  filesWritten: string[];           // Relative artifact paths
  filesWrittenAbs: string[];        // Absolute filesystem paths
  outRootAbs: string;               // Actual output root used
  summary: {
    totalFiles: number;
    totalBytes: number;
  };
}
```

**Fields Present When `success=false`:**

```typescript
interface ApplyResult {
  success: false;
  filesWritten: string[];           // Partial success paths
  failures: Array<{
    path: string;                   // Artifact path that failed
    reason: string;                 // Error code + message
    attemptPath?: string;           // Actual path attempted (debugging)
    expected?: {                    // Expected values
      sha256?: string;
      bytes?: number;
    };
    actual?: {                      // Actual values (if verification failed)
      sha256?: string;
      bytes?: number;
    };
  }>;
  error: string;                    // Summary error message
}
```

### Windows Long Path Support

Node.js handles paths > 260 characters automatically on Windows 10+ (v1607+).

**Requirements:**
- Windows 10 Anniversary Update (1607) or later
- Node.js v18+ (native long path support)

**Example:**

```typescript
// Works with paths > 260 chars
const manifest = {
  artifacts: [{
    path: "level000/level001/.../level100/file.txt", // 300+ chars
    // ... content ...
  }]
};

const result = await apply({ manifest, mode: "fs", repoPath: absPath });
// ✅ Success - filesWrittenAbs[0] has full 300+ char path
```

### Error Code Reference

| Code | Cause | Solution |
|------|-------|----------|
| `ERR_REPOPATH_RELATIVE_UNSAFE` | Relative path resolves to HOME | Use absolute path or set `AXIOM_REPO_ROOT` |
| `ERR_AXIOM_REPO_ROOT_MUST_BE_ABSOLUTE` | `AXIOM_REPO_ROOT` is relative | Set to absolute path |
| `ERR_AXIOM_REPO_ROOT_NOT_FOUND` | `AXIOM_REPO_ROOT` doesn't exist | Create directory or fix path |
| `ERR_ARTIFACT_PATH_BACKSLASH` | Path contains `\` | Use forward slashes `/` |
| `ERR_ARTIFACT_PATH_ABSOLUTE` | Path starts with `/` or drive letter | Use relative path |
| `ERR_ARTIFACT_PATH_TRAVERSAL` | Path contains `..` | Remove parent directory references |
| `ERR_ARTIFACT_PATH_RESERVED_WINDOWS` | Name is CON/PRN/etc | Rename file |
| `ERR_ARTIFACT_PATH_TRAILING` | Trailing space/dot (Windows) | Remove trailing characters |
| `ERR_ARTIFACT_PATH_INVALID_CHARS` | Contains `<>:"\|?*` | Use valid filename characters |
| `ERR_WRITE_FAILED` | I/O error during write | Check permissions, disk space |
| `ERR_POST_WRITE_HASH_MISMATCH` | SHA256 doesn't match | Regenerate manifest or check disk |
| `ERR_POST_WRITE_SIZE_MISMATCH` | File size doesn't match | Regenerate manifest or check disk |
| `ERR_ARTIFACT_CONTENT_MISSING` | No inline content or cached artifact | Include `contentUtf8`/`contentBase64` |

### Security Best Practices

1. **Always use absolute `repoPath` in production** - avoid relative path resolution
2. **Set `AXIOM_REPO_ROOT` in CI/CD** - explicit control over output location
3. **Validate manifests** - use JSON schema validation (schemas/ directory)
4. **Check `ApplyResult.failures[]`** - handle partial successes gracefully
5. **Monitor disk space** - atomic writes require 2x file size temporarily
6. **Use `AXIOM_OUT_ROOT` for cross-drive** - ensure tmp files on target volume

---

## Arhitectură (pe scurt)
- `@axiom/core` – IR (Zod), parser `.axm`, validator semantic (efecte gate‑uite prin capabilities).
- `@axiom/engine` – generate + manifest + (stub) check; profile‑aware emitters.
- `@axiom/mcp` – server HTTP demo (MCP‑like): `/parse`, `/validate`, `/generate`, `/check`.
- `@axiom/emitter-*` – plugin‑uri: `webapp`, `apiservice`, `batchjob`, `docker`.
- `@axiom/policies` – stub hooks pentru checks.
- `profiles/default.json` – mapare `subtype → emitter` (config, nu limbaj).
- `packages/axiom-tests` – test end‑to‑end minimal (golden‑style light).

## Principii
- Intenții & constrângeri, nu tehnologii.
- Determinism: input identic → artefacte identice (manifest cu hash‑uri).
- MCP fără AI: doar tools deterministe. AI-ul trăiește în afară.

## Roadmap scurt
- [ ] Sandbox evaluator pentru `expect` + evidence bundle în manifest
- [ ] Reverse‑IR (repo → IR de stare) + AXPatch (JSON‑Patch pe IR)
- [ ] VS Code bridge real (autodiscovery MCP)
- [ ] Emitters complete pentru Next.js, Fastify, Docker, Cloudflare Worker
