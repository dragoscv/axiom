
# AXIOM (MVP) — AI‑native intention language & deterministic engine

**Fără AI în engine. Fără framework-uri în limbaj.**  
Agenții (Claude/GPT/etc.) pot genera AXIOM, iar **engine-ul** îl parsează/validează/generează/verifică.

## Quickstart
```bash
pnpm install
pnpm build

# MCP demo server (HTTP)
pnpm --filter @axiom/mcp dev  # http://localhost:3411

# Parse un .axm
curl -s http://localhost:3411/parse -H 'content-type: application/json'   -d '{"source": "'$(cat examples/blog.axm | sed 's/"/\\"/g')'"}'

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
