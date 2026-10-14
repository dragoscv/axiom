---
"@codai/axiom-mcp": patch
---

`git.cleanTreeFor: ["deploy"]` no longer refuses deploy-class READS (`gcloud run services describe`, `gcloud builds list`, `vercel ls`) on a dirty tree; only mutating deploy commands (the house guard's list) are dirty-gated. Found by the S-1219 cutover dry run.
