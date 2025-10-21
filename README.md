
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
