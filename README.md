
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
