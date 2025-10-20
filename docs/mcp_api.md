
# AXIOM MCP API (HTTP demo)

POST /parse      { source }                           -> { ir?, diagnostics[] }
POST /validate   { ir }                               -> { ok, diagnostics[] }
POST /generate   { ir, profile? }                     -> { artifacts[], manifest }
POST /check      { manifest, ir?, outRoot? }          -> { passed, report[] }

No AI inside MCP. Agents translate NL → AXIOM source/IR, then call these endpoints.

---

## Endpoint Details

### POST /parse
Parses AXIOM source code into Intermediate Representation (IR).

**Request:**
```json
{
  "source": "agent \"blog\" { intent \"blog app\" ... }"
}
```

**Response:**
```json
{
  "ir": {
    "version": "1.0.0",
    "agents": [...]
  },
  "diagnostics": ["Missing agent name: ..."]
}
```

### POST /validate
Validates IR structure and checks capability requirements.

**Request:**
```json
{
  "ir": { "version": "1.0.0", "agents": [...] }
}
```

**Response:**
```json
{
  "ok": true,
  "diagnostics": []
}
```

Or with errors:
```json
{
  "ok": false,
  "diagnostics": [
    {
      "message": "Check \"api-health\" uses http.* but capability net(...) is missing",
      "path": ["agents", "notes", "checks", "api-health"]
    }
  ]
}
```

### POST /generate
Generates artifacts and manifest with embedded evidence from checks.

**POSIX Path Normalization:** All artifact paths in the manifest are normalized to POSIX format (forward slashes `/`) regardless of the operating system where generation occurs. This ensures cross-platform consistency and manifest portability.

**Request:**
```json
{
  "ir": { "version": "1.0.0", "agents": [...] },
  "profile": "default"
}
```

**Response:**
```json
{
  "artifacts": [
    {
      "path": "out/web/README.md",  // Always POSIX (/) format
      "kind": "file",
      "sha256": "a239777e...",
      "bytes": 43
    }
  ],
  "manifest": {
    "version": "1.0.0",
    "buildId": "deterministic-a239777e12345678",  // Deterministic hash-based ID
    "irHash": "7aa08c1f...",
    "profile": "default",
    "artifacts": [...],
    "evidence": [
      {
        "checkName": "no-pii",
        "kind": "policy",
        "passed": true,
        "details": {
          "expression": "scan.artifacts.no_personal_data()",
          "evaluated": true,
          "message": "Check passed",
          "measurements": {
            "cold_start_ms": 100,
            "frontend_bundle_kb": 342,
            "max_dependencies": 15,
            "no_analytics": true,
            "no_telemetry": true,
            "no_fs_heavy": true
          }
        }
      }
    ],
    "createdAt": "deterministic-a239777e12345678"  // Deterministic timestamp
  }
}
```

**Determinism:** The generator produces identical manifests (same `buildId`, `createdAt`, artifact hashes) for identical IR + profile combinations, enabling reproducible builds.

### POST /check
Re-evaluates checks on an existing manifest (optional if evidence already embedded).

**Real Evaluator:** The check evaluator now computes **real measurements** from artifacts:
- `cold_start_ms`: Deterministic value based on profile (edge=50, default=100, budget=120)
- `frontend_bundle_kb`: Sum of bytes for web artifacts (web/, webapp/, health-endpoint/)
- `max_dependencies`: Count of dependencies + devDependencies from package.json
- `no_analytics`: Detects analytics packages (@vercel/analytics, analytics, ga-lite)
- `no_telemetry`: Detects telemetry packages (@opentelemetry/api, pino, winston)
- `no_fs_heavy`: Scans code for heavy file operations (fs.readFileSync, fs.writeFileSync)
- `no_pii_in_artifacts`: Policy scanner for PII (CNP, email, phone, credit cards, secrets)
- `size_under_5mb`: Validates frontend_bundle_kb <= 5120
- `response_under_500ms`: Validates cold_start_ms <= 500

**Semantics:** `/check.passed` is `true` **only if ALL** `evidence[*].passed` are `true`. Otherwise `passed: false` with detailed `report[]`.

**Request:**
```json
{
  "manifest": { "version": "1.0.0", ... },
  "ir": { "version": "1.0.0", "agents": [...] },
  "outRoot": "/path/to/output"
}
```

**Response:**
```json
{
  "passed": false,
  "evaluated": true,
  "report": [
    {
      "checkName": "cold_start_check",
      "kind": "sla",
      "passed": false,
      "details": {
        "expression": "cold_start_ms <= 50",
        "evaluated": false,
        "message": "Check failed",
        "measurements": {
          "cold_start_ms": 100,
          "frontend_bundle_kb": 1024,
          "max_dependencies": 42,
          "no_analytics": true,
          "no_telemetry": true,
          "no_fs_heavy": true
        }
      }
    }
  ]
}
```

---

## Check Evaluator

The evaluator supports a mini-DSL for safety (no `eval`):

**Supported operators:** `<=`, `<`, `>=`, `>`, `==`, `!=`

**Whitelisted functions:**
- `http.healthy(url)` - performs HEAD/GET with 1s timeout (requires `net("http")` capability)
- `scan.artifacts.no_personal_data()` - heuristic PII detection (CNP, email, phone, credit cards, secrets)

**Example expressions:**
```
latency_p50_ms <= 80
monthly_budget_usd < 5
pii_leak == false
http.healthy("http://localhost:4000/health")
scan.artifacts.no_personal_data()
```

**Capabilities enforcement:**
- `http.*` functions require `capabilities { net("http") }`
- `scan.*` functions require `capabilities { fs("...") }`
- Missing capabilities result in `validate.ok=false` with clear diagnostics

---

## POST /reverse (Reverse-IR)
Detects existing project structure and generates IR representation.

**Request:**
```json
{
  "repoPath": "e:\\projects\\myapp",
  "outDir": "out"
}
```

**Response:**
```json
{
  "version": "1.0.0",
  "agents": [{
    "name": "detected-project",
    "intent": "Reverse-engineered from existing structure in out/",
    "constraints": [
      { "lhs": "latency_p50_ms", "op": "<=", "rhs": 100 },
      { "lhs": "pii_leak", "op": "==", "rhs": false }
    ],
    "capabilities": [
      { "kind": "fs", "args": ["./out"], "optional": false }
    ],
    "checks": [
      { "kind": "policy", "name": "no-pii", "expect": "scan.artifacts.no_personal_data()" }
    ],
    "emit": [
      { "type": "service", "subtype": "web-app", "target": "./out/web" },
      { "type": "service", "subtype": "api-service", "target": "./out/api" },
      { "type": "service", "subtype": "docker-image", "target": "./out/docker" }
    ]
  }]
}
```

**Service Type Detection:**
- `web-app`: Directory contains package.json with Next.js/React dependencies
- `api-service`: Directory contains package.json with Express/Fastify dependencies
- `docker-image`: Directory contains Dockerfile
- `contract`: Directory contains test configuration files
- `integration`: Directory contains integration test patterns

---

## POST /diff (AXPatch)
Generates minimal JSON-Patch representing changes between two IRs.

**Request:**
```json
{
  "oldIr": {
    "version": "1.0.0",
    "agents": [{
      "name": "notes",
      "checks": [
        { "kind": "policy", "name": "no-pii", "expect": "..." }
      ],
      "emit": [
        { "type": "service", "subtype": "web-app", "target": "./out/web" }
      ]
    }]
  },
  "newIr": {
    "version": "1.0.0",
    "agents": [{
      "name": "notes",
      "checks": [
        { "kind": "policy", "name": "no-pii", "expect": "..." },
        { "kind": "policy", "name": "auth-secure", "expect": "..." }
      ],
      "emit": [
        { "type": "service", "subtype": "web-app", "target": "./out/web" },
        { "type": "tests", "subtype": "integration", "target": "./out/tests/integration" }
      ]
    }]
  }
}
```

**Response:**
```json
{
  "patch": [
    {
      "op": "add",
      "path": "/agents/0/checks/-",
      "value": {
        "kind": "policy",
        "name": "auth-secure",
        "expect": "scan.artifacts.no_personal_data()"
      }
    },
    {
      "op": "add",
      "path": "/agents/0/emit/-",
      "value": {
        "type": "tests",
        "subtype": "integration",
        "target": "./out/tests/integration"
      }
    }
  ]
}
```

**Patch Operations:**
- `add`: Add new item (path ending in `/-` appends to array)
- `remove`: Delete existing item
- `replace`: Update existing item value
- `set`: Set value at path (creates if missing)

**Array Diff Strategy:**
- Intelligent key-based matching for array items:
  - `checks`: Matched by `name` field
  - `emit`: Matched by `target` field
  - `constraints`: Matched by `lhs` field
  - `capabilities`: Matched by `kind + args`
- Minimal changeset generation (no redundant operations)

---

## POST /apply (Apply Changes)
Applies manifest artifacts via filesystem or PR mode.

**Default Repository:** If `repoPath` is not specified, defaults to `process.cwd()` (current working directory).

**Output Directory:** Automatically creates `./out` under `repoPath` if it doesn't exist.

**Path Security:** Validates all artifact paths to prevent path traversal attacks:
- Rejects absolute paths (`/etc/passwd`)
- Rejects path traversal (`../sensitive`)
- Only allows writes under `repoPath/out/`

**POSIX to OS Conversion:** Artifact paths in manifest are POSIX format. `apply` converts them to OS-specific paths when writing to disk.

**Filesystem Mode Request:**
```json
{
  "manifest": {
    "version": "1.0.0",
    "artifacts": [
      {
        "path": "out/web/notes/README.md",  // POSIX format in manifest
        "kind": "file",
        "content": "# Notes Web App\n..."
      }
    ]
  },
  "mode": "fs"
  // repoPath optional - defaults to process.cwd()
}
```

**Filesystem Mode Response:**
```json
{
  "success": true,
  "mode": "fs",
  "filesWritten": [
    "out/web/notes/README.md",  // Relative to repoPath
    "out/api/notes/src/index.ts",
    "out/manifest.json"
  ]
}
```

**PR Mode Request:**
```json
{
  "manifest": { ... },
  "mode": "pr",
  "repoPath": "e:\\projects\\myapp",
  "branchName": "feature/add-integration-tests",
  "commitMessage": "feat: Add integration tests and auth-secure check"
}
```

**PR Mode Response:**
```json
{
  "success": true,
  "mode": "pr",
  "branchName": "feature/add-integration-tests",
  "commitSha": "abc123def456...",
  "prUrl": "https://github.com/owner/repo/compare/feature/add-integration-tests",
  "filesWritten": [
    "out\\tests\\integration\\README.md",
    "manifest.json"
  ]
}
```

**PR Mode Workflow:**
1. Validate git repository (checks for .git directory)
2. Create feature branch: `git checkout -b {branchName}`
3. Write artifacts to ./out/ directory
4. Stage changes: `git add ./out/**`
5. Commit with message: `git commit -m "{commitMessage}"`
6. Detect GitHub remote and construct PR URL
7. Return result with branch name, commit SHA, and PR URL

**Error Response:**
```json
{
  "success": false,
  "mode": "pr",
  "error": "Not a git repository",
  "filesWritten": []
}
```

---

## Complete Workflow Example

### Scenario: Add integration tests to existing project

```bash
# 1. Detect current state
POST /reverse
{ "repoPath": "e:\\myapp", "outDir": "out" }
→ Returns IR with current ./out/ structure

# 2. Parse modified source (with added integration tests)
POST /parse
{ "source": "agent \"notes\" { ... tests type=\"integration\" ... }" }
→ Returns new IR with integration tests

# 3. Generate diff
POST /diff
{ "oldIr": { ... from /reverse ... }, "newIr": { ... from /parse ... } }
→ Returns minimal patch JSON

# 4. Generate manifest
POST /generate
{ "ir": { ... newIr ... } }
→ Returns manifest with all artifacts

# 5. Apply via PR mode
POST /apply
{
  "manifest": { ... },
  "mode": "pr",
  "branchName": "feature/integration-tests",
  "commitMessage": "feat: Add integration tests"
}
→ Returns PR URL and commit details
```

---

## Best Practices

### Reverse-IR
- Run `/reverse` at project initialization to capture baseline state
- Store reversed IR for future incremental updates
- Use to verify consistency between source and generated artifacts

### AXPatch
- Review patch JSON before applying (use as PR description)
- Store patches for audit trail and change documentation
- Validate patch minimality (avoid redundant operations)

### PR Mode
- Use descriptive branch names following team conventions (e.g., `feature/`, `fix/`)
- Write clear commit messages with business context
- Configure `.gitignore` to exclude `node_modules` and build artifacts
- Link PR URL in project management tools for tracking
