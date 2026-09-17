
# Examples

## blog.axm
Minimal program that emits a web app placeholder, an API placeholder, and a manifest.

### Build all
```bash
pnpm install
pnpm build
```

### Start MCP HTTP server (demo)
```bash
pnpm --filter @axiom/mcp dev
# listens on http://localhost:3411
```

### Parse
```bash
curl -s http://localhost:3411/parse -H 'content-type: application/json' -d '{"source": "'$(cat examples/blog.axm | sed 's/"/\\\"/g')'"}'
```

### Generate from IR
```bash
curl -s http://localhost:3411/generate -H 'content-type: application/json' -d @examples/blog.ir.json
# Artifacts and manifest are written under working directory (manifest.json)
```
