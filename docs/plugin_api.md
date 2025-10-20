
# AXIOM Plugin API (Emitters)

Each emitter provides:
- `subtype: string` (e.g., "web-app", "api-service", "batch-job")
- `generate(ctx: EmitterContext): Promise<void>`

`EmitterContext`:
- `ir`, `agent`, `target`, `profile?`
- `write(filePath: string, content: string): void`

Emitters must avoid network access unless capabilities & policy allow it (to be enforced in engine revisions).
