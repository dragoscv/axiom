# AXIOM Intermediate Representation (IR) Specification

## Overview

The AXIOM IR is a JSON representation of application requirements, constraints, and deployment specifications. It serves as:
- An intermediate format between `.axm` source files and generated artifacts
- A machine-readable specification for code generation and validation
- A version-able document for change tracking and incremental updates

## IR Schema

```typescript
interface TAxiomIR {
  version: string;
  agents: TAgentIR[];
}

interface TAgentIR {
  name: string;
  intent: string;
  constraints: TConstraint[];
  capabilities: TCapability[];
  checks: TCheck[];
  emit: TEmitItem[];
}

interface TConstraint {
  lhs: string;       // Left-hand side variable
  op: string;        // Operator: <=, <, >=, >, ==, !=
  rhs: number | boolean | string;
}

interface TCapability {
  kind: string;      // "fs", "net", "secret", etc.
  args: string[];
  optional: boolean;
}

interface TCheck {
  kind: string;      // "policy", "sla", "unit"
  name: string;
  expect: string;    // Expression to evaluate
}

interface TEmitItem {
  type: string;      // "service", "tests", "manifest"
  subtype?: string;  // "web-app", "api-service", "docker-image", "contract", "integration"
  target: string;    // Relative path for output
}
```

## Reverse-IR: Detecting Existing Project Structure

The reverse-IR module (`packages/axiom-engine/src/reverse-ir.ts`) analyzes existing project directories to generate an IR representation of the current state. This enables onboarding existing projects and incremental modifications.

### Detection Logic

```yaml
Directory Analysis:
  - Scans ./out/ subdirectories for existing artifacts
  - Identifies service types by project structure:
    * web-app: Contains package.json with Next.js dependencies
    * api-service: Contains package.json with Express/Fastify
    * docker-image: Contains Dockerfile
    * contract: Contains test configuration files
    * integration: Contains integration test patterns
  
Service Type Detection:
  detectServiceType(dirPath: string): string | null
    - Check for package.json: Read dependencies to infer web-app or api-service
    - Check for Dockerfile: Infer docker-image
    - Check for .test.ts/.spec.ts: Infer contract tests
    - Check for test/ or __tests__/: Infer integration tests
    - Return null if no patterns match (generic emit item)

IR Construction:
  reverseIR(options: ReverseIROptions): TAxiomIR
    - Scan outDir (default: "out") for subdirectories
    - Detect service type for each directory
    - Construct emit items with detected types and targets
    - Add default capabilities: fs(./out), net(http)
    - Add default constraints: latency_p50_ms <= 100, pii_leak == false
    - Add default checks: policy "no-pii"
    - Return complete TAxiomIR representing current state
```

### Example Reverse-IR Output

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

## AXPatch: Incremental IR Changes

The AXPatch module (`packages/axiom-engine/src/axpatch.ts`) implements JSON-Patch for minimal, reviewable IR modifications. This enables:
- Clear diff visualization for code reviews
- Minimal changesets for PR descriptions
- Precise application of incremental updates

### Patch Format

```typescript
interface AXPatch {
  op: "add" | "remove" | "replace" | "set";
  path: string;    // JSON pointer (e.g., "/agents/0/checks/2")
  value?: any;     // For add/replace/set operations
}
```

### Diff Algorithm

```yaml
diff(oldIR, newIR): AXPatch[]
  - Deep comparison of IR structures
  - Generate minimal set of patch operations
  - Optimize array diffs with key-based matching:
    * checks: Match by "name" field
    * emit: Match by "target" field
    * constraints: Match by "lhs" field
    * capabilities: Match by "kind" + "args"
  - Return ordered list of patch operations

Array Diff Strategy:
  - Identify common items by key function
  - Generate "replace" for modified items
  - Generate "add" for new items (append with path/-) 
  - Generate "remove" for deleted items
  - Preserve ordering where possible
```

### Example Patch

```json
[
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
```

## Apply: PR Mode for Incremental Changes

The apply module (`packages/axiom-engine/src/apply.ts`) provides two modes for applying manifest changes:
- **Filesystem Mode (`mode: "fs"`)**: Direct write to ./out/ directory
- **PR Mode (`mode: "pr"`)**: Create git branch, commit changes, provide PR URL

### PR Mode Workflow

```yaml
applyPR(options: ApplyOptions): ApplyResult
  1. Validate Git Repository:
     - Check for .git directory
     - Ensure clean working tree (optional)
  
  2. Create Feature Branch:
     - Generate branch name: options.branchName or "axiom/update-{timestamp}"
     - Execute: git checkout -b {branchName}
  
  3. Write Artifacts:
     - Apply all manifest artifacts to ./out/
     - Create parent directories as needed
     - Write file contents from manifest
  
  4. Commit Changes:
     - Stage artifacts: git add ./out/**
     - Commit with message: options.commitMessage or "feat: AXIOM incremental update"
     - Record commit SHA for result
  
  5. Detect PR URL:
     - Read remote URL: git config --get remote.origin.url
     - Parse GitHub repository (owner/repo)
     - Construct PR URL: https://github.com/{owner}/{repo}/compare/{branchName}
  
  6. Return Result:
     - success: true
     - mode: "pr"
     - branchName: string
     - commitSha: string
     - prUrl: string (if GitHub detected)
     - filesWritten: string[]
```

### Integration with MCP Server

```yaml
POST /reverse:
  Request: { repoPath?: string, outDir?: string }
  Response: { version, agents[] }
  Purpose: Detect existing project structure

POST /diff:
  Request: { oldIr: TAxiomIR, newIr: TAxiomIR }
  Response: { patch: AXPatch[] }
  Purpose: Generate minimal changeset

POST /apply:
  Request: { manifest, mode: "fs"|"pr", repoPath?, branchName?, commitMessage? }
  Response: { success, mode, filesWritten[], branchName?, commitSha?, prUrl? }
  Purpose: Apply changes via filesystem or PR
```

## Complete Workflow Example

### Scenario: Add integration tests to existing notes application

```bash
# 1. Detect current state
POST /reverse
{ "repoPath": "e:\\projects\\myapp", "outDir": "out" }
→ Returns IR representing current ./out/ structure

# 2. Modify source to add integration tests
agent "notes" {
  # ... existing configuration ...
  emit {
    # ... existing emit items ...
    tests type="integration" target="./out/tests/integration"  # NEW
  }
  checks {
    # ... existing checks ...
    policy "auth-secure" expect scan.artifacts.no_personal_data()  # NEW
  }
}

# 3. Parse modified source
POST /parse
{ "source": "agent \"notes\" { ... }" }
→ Returns newIr with integration tests

# 4. Generate diff (oldIr from /reverse, newIr from /parse)
POST /diff
{ "oldIr": { ... }, "newIr": { ... } }
→ Returns minimal patch JSON:
[
  { "op": "add", "path": "/agents/0/emit/-", "value": { "type": "tests", "subtype": "integration", ... } },
  { "op": "add", "path": "/agents/0/checks/-", "value": { "kind": "policy", "name": "auth-secure", ... } }
]

# 5. Generate manifest from new IR
POST /generate
{ "ir": { ... newIr ... } }
→ Returns manifest with all artifacts including new integration tests

# 6. Apply via PR mode
POST /apply
{ 
  "manifest": { ... },
  "mode": "pr",
  "branchName": "feature/add-integration-tests",
  "commitMessage": "feat: Add integration tests and auth-secure check"
}
→ Returns:
{
  "success": true,
  "mode": "pr",
  "branchName": "feature/add-integration-tests",
  "commitSha": "abc123...",
  "prUrl": "https://github.com/owner/repo/compare/feature/add-integration-tests",
  "filesWritten": [
    "out/tests/integration/README.md",
    "manifest.json",
    ...
  ]
}
```

## Best Practices

### Reverse-IR
- Run /reverse at project initialization to capture current state
- Store reversed IR as baseline for future incremental changes
- Use reversed IR to verify artifact generation consistency
- Detect service types accurately by analyzing multiple indicators

### AXPatch
- Review patch JSON before applying to understand changes
- Use patch as PR description for clear change documentation
- Store historical patches for audit trail
- Validate patch minimality (no redundant operations)

### PR Mode
- Use descriptive branch names following team conventions
- Write clear commit messages explaining business intent
- Link PR URL in project management tools
- Verify branch creation before pushing to remote
- Configure .gitignore to exclude node_modules and build artifacts

## IR Versioning

```yaml
Version Evolution:
  - IR version "1.0.0": Initial specification
  - Future versions: Backward-compatible additions
  - Breaking changes: Increment major version
  - Validation: Use Zod schema for runtime type checking
```

## IR Extension Points

```yaml
Custom Emitter Types:
  - Register new emit.type values via plugin system
  - Implement emitter interface: generate(agent, emit, outDir)
  - Package as @axiom/emitter-{type}

Custom Check Functions:
  - Register new functions via @axiom/policies
  - Implement evaluator function: (context) => boolean
  - Document required capabilities

Custom Capabilities:
  - Define new capability.kind values
  - Implement capability validator
  - Document required environment/permissions
```

## Troubleshooting

### Reverse-IR Issues
```yaml
Empty IR Returned:
  - Check: ./out/ directory exists and is readable
  - Check: Subdirectories contain recognizable project files
  - Solution: Create sample project structure or specify correct outDir

Service Type Not Detected:
  - Check: package.json contains valid dependencies
  - Check: Dockerfile exists and is parseable
  - Solution: Add explicit type annotations or improve detection heuristics
```

### AXPatch Issues
```yaml
Large Patch Size:
  - Check: Old and new IRs are significantly different
  - Check: Key functions correctly identify matching items
  - Solution: Ensure incremental changes, not full rewrites

Patch Application Fails:
  - Check: Old IR matches current state exactly
  - Check: Patch operations are ordered correctly
  - Solution: Re-generate patch from actual current state
```

### PR Mode Issues
```yaml
"Not a git repository":
  - Solution: Initialize git with: git init

Branch Creation Fails:
  - Check: Branch name is valid (no spaces, special chars)
  - Check: Branch doesn't already exist
  - Solution: Use unique branch name or delete existing branch

PR URL Not Generated:
  - Check: Git remote "origin" exists
  - Check: Remote URL follows GitHub pattern
  - Solution: Add GitHub remote or manually construct PR URL
```

## Future Enhancements

### Reverse-IR
- ML-based service type detection from code patterns
- Support for additional project structures (Rust, Python, etc.)
- Detection of environment variables and secrets usage
- API contract reverse-engineering from OpenAPI specs

### AXPatch
- Three-way merge support for conflict resolution
- Patch composition and optimization
- Semantic diff with natural language descriptions
- Patch validation with schema constraints

### PR Mode
- Integration with GitHub API for automated PR creation
- Support for GitLab, Bitbucket, Azure DevOps
- Automated PR description generation from patch
- CI/CD workflow triggers on branch creation
- Multi-repository coordination for microservices

## References

- JSON-Patch Specification (RFC 6902): https://tools.ietf.org/html/rfc6902
- JSON Pointer Specification (RFC 6901): https://tools.ietf.org/html/rfc6901
- Git Workflow Best Practices: https://www.atlassian.com/git/tutorials/comparing-workflows
