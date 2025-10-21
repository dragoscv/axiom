
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
