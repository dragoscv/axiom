---
"@codai/axiom-mcp": minor
---

Gate coordination adapter and git-state facts (S-1212, S-1213). `coord.ts` reads a generic file
protocol of marks (frozen/blocked resource classes), leases (protected worktree slots) and
queue-required wrappers (`coord.frozen`, `coord.leased`, `coord.queueRequired`), with the agentq
mapping as `AGENTQ_EXAMPLE`. `gitfacts.ts` reads `HEAD`, refs and the index (DIRC v2/v3/v4)
straight from `.git` without spawning git, for `git.dirtyTree`, `git.noPathspec` and `git.branch`.
