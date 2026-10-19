---
"@codai/axiom-mcp": patch
---

Close CodeQL `js/file-system-race` findings: `gitDirs`, the index stat check, session-guard
`hashFile`, undo pre-images and the fleet profile probe now open the file first and verify /
read through the held descriptor, so the checked file is the file that is read.
